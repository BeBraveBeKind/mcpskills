/**
 * GET /.netlify/functions/badge?repo=owner/repo
 * Returns an SVG trust badge for embedding in READMEs.
 *
 * Rate limited: 100 requests/hour per IP.
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreRepo } = require('../../lib/scorer');
const { cacheScore, loadScoreCache } = require('../../lib/recommender');
const { hashIP, checkRateLimit } = require('../../lib/auth');

const TIER_COLORS = {
  verified: { bg: '#16a34a', label: 'Verified' },
  established: { bg: '#ca8a04', label: 'Established' },
  new: { bg: '#3b82f6', label: 'New' },
  blocked: { bg: '#dc2626', label: 'Blocked' },
  certified: { bg: '#B8860B', label: 'Certified Safe' },
};

function generateBadgeSVG(repo, score, tier, certified) {
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

  const repo = event.queryStringParameters?.repo;
  const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
  if (!repo || !REPO_RE.test(repo)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Missing ?repo=owner/repo parameter',
    };
  }

  const [owner, repoName] = repo.split('/');

  // Check cache first
  const cache = loadScoreCache();
  let score = null;
  let tier = 'new';

  if (cache[repo]) {
    score = cache[repo].composite;
    tier = cache[repo].tier;
  } else {
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

  // Check certification status
  let certified = false;
  try {
    const certStore = getStore('certifications');
    const raw = await certStore.get(`cert:${repo}`);
    if (raw) {
      const record = JSON.parse(raw);
      certified = record.status === 'certified';
    }
  } catch {}

  const svg = generateBadgeSVG(repo, score, tier, certified);
  return { statusCode: 200, headers, body: svg };
};
