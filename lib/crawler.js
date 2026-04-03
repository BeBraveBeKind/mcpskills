/**
 * lib/crawler.js — Discover new repos and packages from public registries and GitHub search.
 *
 * Sources:
 *   1. MCP Registry (registry.modelcontextprotocol.io) — official MCP servers
 *   2. GitHub topic search — mcp-server, openclaw repos
 *   3. GitHub keyword search — repos with MCP in name/description
 *   4. npm registry search — packages with mcp-server/mcp-tool keywords
 *   5. Smithery registry API — MCP server listings
 *
 * Returns { repos: string[], npmOnlyPackages: string[] }
 */

const { extractGitHubRepo } = require('./resolver');

async function ghApi(path, token) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'mcpskills-crawler' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Discover repos from the MCP Registry.
 * Returns array of "owner/repo" strings.
 */
async function discoverFromMcpRegistry() {
  const repos = [];
  try {
    const res = await fetch('https://registry.modelcontextprotocol.io/v0/servers');
    if (!res.ok) return repos;
    const data = await res.json();
    const servers = data.servers || [];

    for (const entry of servers) {
      const url = entry.server?.repository?.url || '';
      const match = url.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
      if (match) {
        repos.push(`${match[1]}/${match[2].replace(/\.git$/, '')}`);
      }
    }
  } catch (err) {
    console.warn('MCP Registry crawl failed:', err.message);
  }
  return repos;
}

/**
 * Discover repos from GitHub topic search.
 * Searches for recently-pushed repos with mcp-server or openclaw topics.
 * Returns array of "owner/repo" strings.
 */
async function discoverFromGitHubTopics(token, daysBack = 30) {
  const repos = [];
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const queries = [
    `topic:mcp-server+pushed:>${since}`,
    `topic:openclaw+pushed:>${since}`,
    `topic:mcp+pushed:>${since}+stars:>5`,
  ];

  for (const q of queries) {
    try {
      const data = await ghApi(`/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=50`, token);
      if (data?.items) {
        for (const item of data.items) {
          if (!item.archived && !item.fork) {
            repos.push(item.full_name);
          }
        }
      }
      // Rate limit: 10 search requests per minute for authenticated users
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`GitHub topic search failed for "${q}":`, err.message);
    }
  }

  return repos;
}

/**
 * Discover repos from GitHub keyword search.
 * Searches repo names/descriptions for MCP and skill keywords.
 * Returns array of "owner/repo" strings.
 */
async function discoverFromGitHubKeywords(token, daysBack = 14) {
  const repos = [];
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const queries = [
    `mcp-server+in:name+pushed:>${since}+stars:>2`,
    `"model context protocol"+in:description+pushed:>${since}`,
  ];

  for (const q of queries) {
    try {
      const data = await ghApi(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=30`, token);
      if (data?.items) {
        for (const item of data.items) {
          if (!item.archived && !item.fork) {
            repos.push(item.full_name);
          }
        }
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`GitHub keyword search failed for "${q}":`, err.message);
    }
  }

  return repos;
}

/**
 * Discover repos and packages from the npm registry.
 * Searches for packages with MCP-related keywords.
 * Returns { repos: string[], npmOnlyPackages: string[] }
 */
async function discoverFromNpm() {
  const repos = [];
  const npmOnlyPackages = [];
  const keywords = ['mcp-server', 'mcp-tool', 'model-context-protocol', 'openclaw-skill'];

  const searches = keywords.map(async (keyword) => {
    try {
      const res = await fetch(
        `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(keyword)}&size=50`,
        { headers: { 'User-Agent': 'mcpskills-crawler', 'Accept': 'application/json' } }
      );
      if (!res.ok) return;
      const data = await res.json();

      for (const obj of (data.objects || [])) {
        const pkg = obj.package;
        if (!pkg?.name) continue;
        const repo = extractGitHubRepo(pkg.links?.repository);
        if (repo) {
          repos.push(repo);
        } else {
          npmOnlyPackages.push(pkg.name);
        }
      }
    } catch (err) {
      console.warn(`npm search failed for "${keyword}":`, err.message);
    }
  });

  await Promise.all(searches);
  return { repos, npmOnlyPackages };
}

/**
 * Discover repos from the Smithery registry.
 * Returns array of "owner/repo" strings.
 */
async function discoverFromSmithery() {
  const repos = [];
  try {
    const res = await fetch('https://registry.smithery.ai/servers?pageSize=100', {
      headers: { 'User-Agent': 'mcpskills-crawler', 'Accept': 'application/json' },
    });
    if (!res.ok) return repos;
    const data = await res.json();
    const servers = data.servers || data.items || data || [];

    for (const entry of (Array.isArray(servers) ? servers : [])) {
      // Smithery API: qualifiedName is "owner/repo" for GitHub-backed servers (e.g., "LinkupPlatform/linkup-mcp-server")
      // Single-word qualifiedNames (e.g., "instagram") are Smithery-hosted with no GitHub source
      const qn = entry.qualifiedName || '';
      if (qn.includes('/') && !qn.startsWith('@')) {
        repos.push(qn);
        continue;
      }
      // Fallback: try extracting from homepage or other fields
      const repo = extractGitHubRepo(entry.repository) ||
                   extractGitHubRepo(entry.homepage) ||
                   extractGitHubRepo(entry.source);
      if (repo) repos.push(repo);
    }
  } catch (err) {
    console.warn('Smithery crawl failed:', err.message);
  }
  return repos;
}

/**
 * Run all discovery sources and return deduplicated new repos.
 *
 * @param {Set<string>} knownRepos — repos already in cache (lowercase)
 * @param {string} token — GitHub token
 * @param {number} maxNew — cap on how many new repos to return
 * @returns {string[]} — new repos to score
 */
async function discoverNewRepos(knownRepos, token, maxNew = 30) {
  console.log('Starting discovery crawl...');

  const [registryRepos, topicRepos, keywordRepos, npmResult, smitheryRepos] = await Promise.all([
    discoverFromMcpRegistry(),
    discoverFromGitHubTopics(token, 30),
    discoverFromGitHubKeywords(token, 14),
    discoverFromNpm(),
    discoverFromSmithery(),
  ]);

  console.log(`Discovery results: registry=${registryRepos.length}, topics=${topicRepos.length}, keywords=${keywordRepos.length}, npm=${npmResult.repos.length}+${npmResult.npmOnlyPackages.length}, smithery=${smitheryRepos.length}`);

  // Deduplicate GitHub repos and filter out known
  const allRepos = [...registryRepos, ...topicRepos, ...keywordRepos, ...npmResult.repos, ...smitheryRepos];
  const seen = new Set();
  const newRepos = [];

  for (const repo of allRepos) {
    const lower = repo.toLowerCase();
    if (seen.has(lower) || knownRepos.has(lower)) continue;
    seen.add(lower);
    newRepos.push(repo);
  }

  // Deduplicate npm-only packages (no known-repo check since they use different keys)
  const npmSeen = new Set();
  const newNpmPackages = [];
  for (const pkg of npmResult.npmOnlyPackages) {
    const lower = pkg.toLowerCase();
    const npmKey = `npm:${lower}`;
    if (npmSeen.has(lower) || knownRepos.has(npmKey)) continue;
    npmSeen.add(lower);
    newNpmPackages.push(pkg);
  }

  console.log(`Found ${newRepos.length} new repos, ${newNpmPackages.length} new npm-only packages (${knownRepos.size} already known)`);

  return {
    repos: newRepos.slice(0, maxNew),
    npmOnlyPackages: newNpmPackages.slice(0, 10),
  };
}

module.exports = {
  discoverNewRepos,
  discoverFromMcpRegistry,
  discoverFromGitHubTopics,
  discoverFromGitHubKeywords,
  discoverFromNpm,
  discoverFromSmithery,
};
