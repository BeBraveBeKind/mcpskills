/**
 * GET /.netlify/functions/badge?repo=owner/repo
 * Returns an SVG trust badge for embedding in READMEs.
 *
 * Rate limited: 100 requests/hour per IP.
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreAny } = require('../../lib/score-any');
const { cacheScore, loadScoreCache } = require('../../lib/recommender');
const { hashIP, checkRateLimit } = require('../../lib/auth');
const { tryAutoCertify } = require('../../lib/auto-certify');

/**
 * Persist a score to the Netlify Blobs score-cache store.
 * This is the same store the nightly crawler reads, so badge-triggered
 * discoveries permanently enter the ecosystem (no more cold-start amnesia).
 *
 * Also writes a discovery signal so we can count how much of the cache
 * is being fed by badge embeds vs nightly crawl.
 */
async function persistBadgeDiscovery(input, result) {
  try {
    // Write to the persistent score-cache blob (matches nightly-crawl.js format)
    const cacheStore = getStore('score-cache');
    const cacheKey = (result.repo || (result.package ? `npm:${result.package}` : input)).toLowerCase();
    const record = {
      composite: result.composite,
      tier: result.tier,
      mode: result.mode,
      limited: result.limited || false,
      meta: {
        description: result.meta?.description || '',
        stars: result.meta?.stars || 0,
        forks: result.meta?.forks || 0,
        license: result.meta?.license || 'Unknown',
      },
      scannedAt: result.scannedAt,
      discoveredVia: 'badge',
    };
    await cacheStore.set(cacheKey, JSON.stringify(record));

    // Track discovery source for analytics / flywheel metrics
    const discoveryStore = getStore('badge-discoveries');
    const date = new Date().toISOString().slice(0, 10);
    await discoveryStore.set(`${date}:${cacheKey}`, JSON.stringify({
      input,
      cacheKey,
      composite: result.composite,
      tier: result.tier,
      discoveredAt: result.scannedAt,
    }));
  } catch {
    // Non-fatal — badge still renders
  }
}

/**
 * Look up a repo in the persistent Blob score-cache.
 * Returns {score, tier, limited} or null if not cached.
 */
async function lookupBlobCache(input) {
  try {
    const store = getStore('score-cache');
    const keys = [input, input.toLowerCase()];
    for (const k of keys) {
      const raw = await store.get(k);
      if (raw) {
        const record = JSON.parse(raw);
        return {
          score: record.composite,
          tier: record.tier,
          limited: record.limited || false,
        };
      }
    }
  } catch {}
  return null;
}

const TIER_COLORS = {
  verified: { bg: '#16a34a', label: 'Verified' },
  established: { bg: '#ca8a04', label: 'Established' },
  new: { bg: '#3b82f6', label: 'New' },
  blocked: { bg: '#dc2626', label: 'Blocked' },
  certified: { bg: '#B8860B', label: 'Certified Safe' },
  limited: { bg: '#6b7280', label: 'Limited' },
};

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateBadgeSVG(repo, score, tier, certified) {
  repo = escapeXml(repo);
  const tierInfo = certified ? TIER_COLORS.certified : (TIER_COLORS[tier] || TIER_COLORS.new);
  const scoreText = score != null ? `${score}/10` : '?';
  const labelWidth = 100;
  const scoreWidth = 70;
  const tierWidth = 90;
  const totalWidth = labelWidth + scoreWidth + tierWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="MCP Skills: ${scoreText} ${tierInfo.label}">
  <title>MCP Skills Trust Score: ${scoreText} — ${tierInfo.label}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${scoreWidth}" height="20" fill="#333"/>
    <rect x="${labelWidth + scoreWidth}" width="${tierWidth}" height="20" fill="${tierInfo.bg}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">MCP Skills</text>
    <text x="${labelWidth / 2}" y="14">MCP Skills</text>
    <text x="${labelWidth + scoreWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${scoreText}</text>
    <text x="${labelWidth + scoreWidth / 2}" y="14">${scoreText}</text>
    <text x="${labelWidth + scoreWidth + tierWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${tierInfo.label}</text>
    <text x="${labelWidth + scoreWidth + tierWidth / 2}" y="14">${tierInfo.label}</text>
  </g>
</svg>`;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    'Access-Control-Allow-Origin': '*',
  };

  // Initialize Blobs for rate limiting
  connectLambda(event);

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'GET only' };
  }

  // Rate limit: 100/hour per IP
  const ipHash = hashIP(event);
  const rateCheck = await checkRateLimit(ipHash, 'badge');
  if (!rateCheck.allowed) {
    return {
      statusCode: 429,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Rate limit exceeded. Try again later.',
    };
  }

  // Accept input from either ?repo= query param OR the /badge/* path.
  // The /badge/* redirect in netlify.toml can't reliably stuff multi-segment
  // splats into a query string, so we parse the path as a fallback.
  let input = event.queryStringParameters?.repo;
  if (!input) {
    const pathMatch = (event.path || '').match(/^\/(?:badge|\.netlify\/functions\/badge)\/(.+?)\/?$/);
    if (pathMatch) {
      try { input = decodeURIComponent(pathMatch[1]); } catch { input = pathMatch[1]; }
    }
  }
  if (!input || input.trim().length === 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Missing repo. Use /badge/owner/repo or ?repo=owner/repo. Accepts owner/repo, npm:@scope/package, or registry URL.',
    };
  }

  // Cache hierarchy:
  //   1. In-memory cache (data/score-cache.json, baked into deploy) — instant, stale-ok
  //   2. Netlify Blobs score-cache — persistent, shared with nightly crawler
  //   3. Live score via scoreAny() — cold path, persists to Blobs on success
  const cache = loadScoreCache();
  let score = null;
  let tier = 'new';
  let limited = false;
  const cacheKey = input.toLowerCase();

  if (cache[input]) {
    score = cache[input].composite;
    tier = cache[input].tier;
    limited = cache[input].limited || false;
  } else if (cache[cacheKey]) {
    score = cache[cacheKey].composite;
    tier = cache[cacheKey].tier;
    limited = cache[cacheKey].limited || false;
  } else {
    // Check persistent Blob store before scoring live
    const blobHit = await lookupBlobCache(input);
    if (blobHit) {
      score = blobHit.score;
      tier = blobHit.tier;
      limited = blobHit.limited;
    } else {
      // Discovery path: score live, persist to Blobs for the whole ecosystem
      const token = process.env.GITHUB_TOKEN || null;
      try {
        const result = await scoreAny(input, token);
        if (!result.error) {
          score = result.composite;
          tier = result.tier;
          limited = result.limited || false;
          cacheScore(result); // in-memory (best effort)
          await persistBadgeDiscovery(input, result); // persistent Blob store
          // Auto-certify eligible repos on first badge embed. This completes
          // the loop: maintainer embeds badge → gets auto-cert gold badge.
          const certCacheKey = (result.repo || (result.package ? `npm:${result.package}` : input)).toLowerCase();
          await tryAutoCertify(certCacheKey, result, 'badge');
        }
      } catch {
        // Badge still renders with "?" score
      }
    }
  }

  // Check certification status
  let certified = false;
  try {
    const certStore = getStore('certifications');
    // Try both the raw input and resolved repo as cert keys
    const certKeys = [input, cacheKey].filter(Boolean);
    for (const key of certKeys) {
      const raw = await certStore.get(`cert:${key}`);
      if (raw) {
        const record = JSON.parse(raw);
        if (record.status === 'certified') { certified = true; break; }
      }
    }
  } catch {}

  // Use "limited" tier styling for partial scores
  const displayTier = limited ? 'limited' : tier;
  const displayName = input.length > 40 ? input.slice(0, 37) + '...' : input;
  const svg = generateBadgeSVG(displayName, score, displayTier, certified);
  return { statusCode: 200, headers, body: svg };
};
