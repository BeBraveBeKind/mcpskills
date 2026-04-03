/**
 * lib/resolver.js — Registry Resolver
 *
 * Accepts any input format and resolves to a GitHub repo (or npm metadata fallback).
 *
 * Supported inputs:
 *   - owner/repo (passthrough)
 *   - https://github.com/owner/repo
 *   - npm:@scope/package or npm:package
 *   - @scope/package or bare-package-name (auto-detected)
 *   - https://smithery.ai/server/name
 *   - https://openclaw.com/skills/name (or similar OpenClaw URLs)
 *   - https://www.npmjs.com/package/@scope/name
 *
 * Resolution strategy:
 *   1. Parse input → identify source type
 *   2. If GitHub repo, return immediately
 *   3. If registry URL or package name, fetch metadata and extract repo URL
 *   4. If no repo found, return npm metadata for partial scoring
 *
 * Caching: resolution mappings are cached in Netlify Blobs (resolver-cache store).
 */

// Fetch with timeout — prevents slowloris DoS from unresponsive registries
function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Lazy-init blob store
let _resolverCache = null;
let _getStore = null;

function loadGetStore() {
  if (!_getStore) {
    try { _getStore = require('@netlify/blobs').getStore; } catch { _getStore = null; }
  }
  return _getStore;
}

function resolverCache() {
  if (!_resolverCache) {
    const gs = loadGetStore();
    if (gs) _resolverCache = gs('resolver-cache');
  }
  return _resolverCache;
}

// --- Input Detection ---

/**
 * Identify the input type and normalize it.
 * Returns { type, value, raw }
 */
function identifyInput(input) {
  if (!input || typeof input !== 'string') return { type: 'invalid', value: null, raw: input };

  input = input.trim().replace(/\/$/, '');

  // Reject excessively long inputs and control characters
  if (input.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input)) {
    return { type: 'invalid', value: null, raw: input };
  }

  // GitHub URL: https://github.com/owner/repo[/anything]
  const ghMatch = input.match(/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)/);
  if (ghMatch) {
    return { type: 'github', value: `${ghMatch[1]}/${ghMatch[2]}`, raw: input };
  }

  // npm URL: https://www.npmjs.com/package/@scope/name or /package/name
  const npmUrlMatch = input.match(/npmjs\.com\/package\/((?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+)/);
  if (npmUrlMatch) {
    return { type: 'npm', value: npmUrlMatch[1], raw: input };
  }

  // Explicit npm prefix: npm:@scope/package or npm:package
  if (input.startsWith('npm:')) {
    const name = input.slice(4);
    // Validate against npm package name spec: max 214 chars, no control chars,
    // must be scoped (@scope/name) or lowercase alphanumeric with hyphens/dots
    if (!name || name.length > 214 || /[\x00-\x1f\x7f]/.test(name) ||
        !/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) {
      return { type: 'invalid', value: null, raw: input };
    }
    return { type: 'npm', value: name, raw: input };
  }

  // Smithery URL: https://smithery.ai/server/name or /server/owner/name or /server/@scope/name
  const smitheryMatch = input.match(/smithery\.ai\/server(?:s)?\/((?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?)/);
  if (smitheryMatch) {
    return { type: 'smithery', value: smitheryMatch[1], raw: input };
  }

  // OpenClaw URL patterns (adapt as their URL structure becomes clear)
  const openclawMatch = input.match(/(?:openclaw\.com|clawhub\.io|openclaw\.ai)\/(?:skills?|packages?)\/((?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+)/);
  if (openclawMatch) {
    return { type: 'openclaw', value: openclawMatch[1], raw: input };
  }

  // mcp.run URL: https://mcp.run/server/name
  const mcpRunMatch = input.match(/mcp\.run\/(?:server|package)\/((?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+)/);
  if (mcpRunMatch) {
    return { type: 'mcp_run', value: mcpRunMatch[1], raw: input };
  }

  // owner/repo pattern (must be exactly two segments, no @ prefix)
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(input) && !input.startsWith('@')) {
    return { type: 'github', value: input, raw: input };
  }

  // Scoped npm package: @scope/name
  if (/^@[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(input)) {
    return { type: 'npm', value: input, raw: input };
  }

  // Bare package name heuristic: single word, lowercase, may have hyphens
  // Only match if it looks like a plausible npm package name
  if (/^[a-z][a-z0-9._-]{1,100}$/.test(input)) {
    return { type: 'npm', value: input, raw: input };
  }

  return { type: 'invalid', value: null, raw: input };
}

// --- Registry Resolvers ---

/**
 * Resolve npm package → GitHub repo.
 * Returns { repo, meta } or { repo: null, meta }
 */
async function resolveNpm(packageName) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%40', '@')}`;

  let data;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'MCPSkills-Resolver/1.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return { repo: null, meta: null, error: `npm package "${packageName}" not found` };
    data = await res.json();
  } catch (err) {
    console.error('npm registry fetch error:', err.message);
    return { repo: null, meta: null, error: `Failed to resolve npm package "${packageName}"` };
  }

  // Extract repo URL from repository field
  const repoField = data.repository;
  const repo = extractGitHubRepo(repoField) || extractGitHubRepo(data.homepage) || extractGitHubRepo(data.bugs?.url);

  // Gather npm metadata for partial scoring
  const latest = data['dist-tags']?.latest;
  const latestVersion = latest ? data.versions?.[latest] : null;
  const timeData = data.time || {};
  const versions = Object.keys(data.versions || {});

  const meta = {
    name: data.name,
    description: data.description || '',
    latest: latest || null,
    license: data.license || latestVersion?.license || null,
    maintainers: (data.maintainers || []).map(m => m.name || m.email),
    maintainerCount: (data.maintainers || []).length,
    versions: versions.length,
    created: timeData.created || null,
    lastPublish: timeData[latest] || timeData.modified || null,
    homepage: data.homepage || null,
    keywords: data.keywords || [],
    dependencies: latestVersion?.dependencies ? Object.keys(latestVersion.dependencies).length : 0,
    hasTypes: !!(latestVersion?.types || latestVersion?.typings || data.types),
  };

  return { repo, meta, error: null };
}

/**
 * Resolve Smithery listing → GitHub repo.
 * Smithery pages typically link to the source GitHub repo.
 */
async function resolveSmithery(slug) {
  // Try Smithery's registry API first
  // slug can be "owner/repo" or "name" — encode each segment separately to prevent path traversal
  const safePath = slug.split('/').map(s => encodeURIComponent(s)).join('/');
  const apiUrl = `https://registry.smithery.ai/servers/${safePath}`;
  try {
    const res = await fetchWithTimeout(apiUrl, {
      headers: { 'User-Agent': 'MCPSkills-Resolver/1.0', 'Accept': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      // Smithery qualifiedName is "owner/repo" for GitHub-backed servers
      const qn = data.qualifiedName || '';
      let repo = null;
      if (qn.includes('/') && !qn.startsWith('@')) {
        repo = qn;
      }
      repo = repo || extractGitHubRepo(data.repository) ||
                      extractGitHubRepo(data.homepage) ||
                      extractGitHubRepo(data.source);
      if (repo) return { repo, meta: { source: 'smithery', slug, name: data.displayName || qn }, error: null };
    }
  } catch {}

  // Fallback: scrape the page for GitHub links
  try {
    const pageUrl = `https://smithery.ai/server/${safePath}`;
    const res = await fetchWithTimeout(pageUrl, {
      headers: { 'User-Agent': 'MCPSkills-Resolver/1.0' },
    });
    if (res.ok) {
      // Limit response size to 512KB to prevent memory exhaustion
      const text = await res.text();
      const html = text.length > 512 * 1024 ? text.slice(0, 512 * 1024) : text;
      const ghLink = html.match(/href="(https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)"/);
      if (ghLink) {
        const repo = extractGitHubRepo(ghLink[1]);
        if (repo) return { repo, meta: { source: 'smithery', slug }, error: null };
      }
    }
  } catch {}

  return { repo: null, meta: { source: 'smithery', slug }, error: `Could not resolve Smithery listing "${slug}" to a source repository` };
}

/**
 * Resolve OpenClaw skill → GitHub repo.
 */
async function resolveOpenClaw(skillName) {
  // OpenClaw doesn't have a stable public API yet.
  // Try common URL patterns and scrape for GitHub links.
  const urls = [
    `https://openclaw.com/skills/${encodeURIComponent(skillName)}`,
    `https://clawhub.io/skills/${encodeURIComponent(skillName)}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'MCPSkills-Resolver/1.0' },
        redirect: 'manual',
      });
      if (res.ok) {
        const text = await res.text();
        const html = text.length > 512 * 1024 ? text.slice(0, 512 * 1024) : text;
        const ghLink = html.match(/href="(https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)"/);
        if (ghLink) {
          const repo = extractGitHubRepo(ghLink[1]);
          if (repo) return { repo, meta: { source: 'openclaw', skillName }, error: null };
        }
      }
    } catch {}
  }

  // Last resort: search npm for the skill name (many OpenClaw skills are also on npm)
  const npmResult = await resolveNpm(skillName);
  if (npmResult.repo) {
    return { repo: npmResult.repo, meta: { ...npmResult.meta, source: 'openclaw', skillName }, error: null };
  }

  return { repo: null, meta: { source: 'openclaw', skillName }, error: `Could not resolve OpenClaw skill "${skillName}" to a source repository` };
}

/**
 * Resolve mcp.run listing → GitHub repo.
 */
async function resolveMcpRun(name) {
  // mcp.run typically has npm packages behind listings
  const npmResult = await resolveNpm(name);
  if (npmResult.repo) {
    return { repo: npmResult.repo, meta: { ...npmResult.meta, source: 'mcp_run' }, error: null };
  }
  return { repo: null, meta: { source: 'mcp_run', name }, error: `Could not resolve mcp.run listing "${name}" to a source repository` };
}

// --- Helpers ---

/**
 * Extract GitHub owner/repo from various URL formats.
 */
function extractGitHubRepo(input) {
  if (!input) return null;

  // Handle object with url field (npm repository format)
  if (typeof input === 'object' && input.url) input = input.url;
  if (typeof input !== 'string') return null;

  // git+https://github.com/owner/repo.git
  // https://github.com/owner/repo
  // github:owner/repo
  // git://github.com/owner/repo.git
  const match = input.match(/github\.com[/:]([\w._-]+)\/([\w._-]+?)(?:\.git)?(?:\/|$|\?|#)/);
  if (match) return `${match[1]}/${match[2]}`;

  // github: shorthand
  const ghShort = input.match(/^github:([\w._-]+)\/([\w._-]+)$/);
  if (ghShort) return `${ghShort[1]}/${ghShort[2]}`;

  return null;
}

// --- Main Resolver ---

/**
 * Resolve any input to a scoring target.
 *
 * Returns:
 *   {
 *     resolved: true/false,
 *     repo: "owner/repo" | null,
 *     inputType: "github" | "npm" | "smithery" | "openclaw" | "mcp_run",
 *     packageName: string | null,
 *     npmMeta: { ... } | null,       // npm metadata for partial scoring
 *     registryMeta: { ... } | null,  // registry-specific metadata
 *     error: string | null
 *   }
 */
async function resolve(input) {
  const id = identifyInput(input);

  if (id.type === 'invalid') {
    return {
      resolved: false,
      repo: null,
      inputType: 'invalid',
      packageName: null,
      npmMeta: null,
      registryMeta: null,
      error: 'Could not parse input. Accepted formats: owner/repo, GitHub URL, npm:package, Smithery URL, or OpenClaw URL.',
    };
  }

  // GitHub passthrough — no resolution needed
  if (id.type === 'github') {
    return {
      resolved: true,
      repo: id.value,
      inputType: 'github',
      packageName: null,
      npmMeta: null,
      registryMeta: null,
      error: null,
    };
  }

  // Check cache first
  const cacheKey = `${id.type}:${id.value}`;
  try {
    const cache = resolverCache();
    if (cache) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        // Cache entries expire after 24h
        if (parsed.cachedAt && Date.now() - new Date(parsed.cachedAt).getTime() < 24 * 60 * 60 * 1000) {
          return { ...parsed, fromCache: true };
        }
      }
    }
  } catch {}

  // Resolve based on type
  let result;

  switch (id.type) {
    case 'npm': {
      const npmResult = await resolveNpm(id.value);
      result = {
        resolved: !!npmResult.repo,
        repo: npmResult.repo,
        inputType: 'npm',
        packageName: id.value,
        npmMeta: npmResult.meta,
        registryMeta: null,
        error: npmResult.repo ? null : `Could not resolve "${id.value}" to a source repository. Trust scoring requires source code access.`,
      };
      break;
    }

    case 'smithery': {
      const smResult = await resolveSmithery(id.value);
      // If Smithery resolved to a repo, also try to get npm metadata
      let npmMeta = null;
      if (smResult.repo) {
        // Don't block on npm lookup — it's supplementary
        try {
          const pkgName = smResult.meta?.name || id.value;
          const npm = await resolveNpm(pkgName);
          npmMeta = npm.meta;
        } catch {}
      }
      result = {
        resolved: !!smResult.repo,
        repo: smResult.repo,
        inputType: 'smithery',
        packageName: null,
        npmMeta,
        registryMeta: smResult.meta,
        error: smResult.error,
      };
      break;
    }

    case 'openclaw': {
      const ocResult = await resolveOpenClaw(id.value);
      result = {
        resolved: !!ocResult.repo,
        repo: ocResult.repo,
        inputType: 'openclaw',
        packageName: null,
        npmMeta: ocResult.meta?.name ? ocResult.meta : null,
        registryMeta: ocResult.meta,
        error: ocResult.error,
      };
      break;
    }

    case 'mcp_run': {
      const mrResult = await resolveMcpRun(id.value);
      result = {
        resolved: !!mrResult.repo,
        repo: mrResult.repo,
        inputType: 'mcp_run',
        packageName: id.value,
        npmMeta: mrResult.meta,
        registryMeta: null,
        error: mrResult.error,
      };
      break;
    }

    default:
      result = {
        resolved: false,
        repo: null,
        inputType: id.type,
        packageName: null,
        npmMeta: null,
        registryMeta: null,
        error: `Unsupported input type: ${id.type}`,
      };
  }

  // Cache the result
  try {
    const cache = resolverCache();
    if (cache && (result.resolved || result.npmMeta)) {
      const cacheEntry = { ...result, cachedAt: new Date().toISOString(), fromCache: false };
      delete cacheEntry.fromCache;
      await cache.set(cacheKey, JSON.stringify(cacheEntry));
    }
  } catch {}

  return result;
}

module.exports = { resolve, identifyInput, extractGitHubRepo, resolveNpm };
