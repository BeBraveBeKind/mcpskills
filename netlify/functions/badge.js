/**
 * GET /.netlify/functions/badge?repo=owner/repo
 * Returns an SVG trust badge for embedding in READMEs.
 *
 * Usage in markdown:
 *   ![Trust Score](https://mcpskills.io/.netlify/functions/badge?repo=owner/repo)
 *
 * Badge shows: score, tier icon, and "Verified by MCP Skills" text.
 * Links to full report at mcpskills.io.
 */

const { scoreRepo } = require('../../lib/scorer');
const { cacheScore, loadScoreCache } = require('../../lib/recommender');

const TIER_COLORS = {
  verified: { bg: '#16a34a', label: 'Verified' },
  established: { bg: '#ca8a04', label: 'Established' },
  new: { bg: '#3b82f6', label: 'New' },
  blocked: { bg: '#dc2626', label: 'Blocked' },
};

function generateBadgeSVG(repo, score, tier) {
  const tierInfo = TIER_COLORS[tier] || TIER_COLORS.new;
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
    'Cache-Control': 'public, max-age=3600, s-maxage=3600', // Cache 1 hour
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'GET only' };
  }

  const repo = event.queryStringParameters?.repo;
  if (!repo || !repo.includes('/')) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Missing ?repo=owner/repo parameter',
    };
  }

  const [owner, repoName] = repo.split('/');

  // Check cache first — avoid re-scanning for every badge request
  const cache = loadScoreCache();
  let score = null;
  let tier = 'new';

  if (cache[repo]) {
    score = cache[repo].composite;
    tier = cache[repo].tier;
  } else {
    // Score it live and cache
    const token = process.env.GITHUB_TOKEN || null;
    try {
      const result = await scoreRepo(owner, repoName, token);
      if (!result.error) {
        score = result.composite;
        tier = result.tier;
        cacheScore(result);
      }
    } catch {
      // Badge still renders with "?" score
    }
  }

  const svg = generateBadgeSVG(repo, score, tier);
  return { statusCode: 200, headers, body: svg };
};
