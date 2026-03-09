/**
 * POST /.netlify/functions/batch-scan
 * Scan multiple repos and seed the score cache.
 * Protected by a simple admin key (ADMIN_KEY env var).
 *
 * Body: { "repos": ["owner/repo", ...], "key": "admin-key" }
 * Returns: { results: [...], cached: N }
 */

const { scoreRepo } = require('../../lib/scorer');
const { cacheScore } = require('../../lib/recommender');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Simple admin auth
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && body.key !== adminKey) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Invalid admin key' }) };
  }

  const repos = body.repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing repos array' }) };
  }

  // Cap at 10 per request (Netlify functions have 10s timeout on free tier)
  const batch = repos.slice(0, 10);
  const token = process.env.GITHUB_TOKEN || null;
  const results = [];

  for (const repo of batch) {
    const [owner, repoName] = repo.split('/');
    if (!owner || !repoName) {
      results.push({ repo, status: 'invalid' });
      continue;
    }

    try {
      const result = await scoreRepo(owner, repoName, token);
      if (result.error) {
        results.push({ repo, status: 'error', error: result.error });
      } else {
        cacheScore(result);
        results.push({ repo, status: 'ok', score: result.composite, tier: result.tier });
      }
    } catch (e) {
      results.push({ repo, status: 'error', error: e.message });
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      scanned: results.filter(r => r.status === 'ok').length,
      failed: results.filter(r => r.status !== 'ok').length,
      results,
      remaining: repos.length > 10 ? repos.slice(10) : [],
    }),
  };
};
