/**
 * POST /.netlify/functions/batch-scan
 * Scan multiple repos and seed the score cache.
 *
 * Auth: ADMIN_KEY (body.key) or Pro-tier API key (X-API-Key header)
 *   - Admin: up to 10 repos per request
 *   - Pro: up to 5 repos per request (consumes 1 credit per repo, or unlimited)
 *
 * Body: { "repos": ["owner/repo", ...], "key": "admin-key" }
 * Returns: { results: [...], scanned: N, failed: N }
 */

const crypto = require('crypto');
const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreAny } = require('../../lib/score-any');
const { cacheScore } = require('../../lib/recommender');
const { validateApiKey, consumeCredit } = require('../../lib/auth');

/** Save score to Netlify Blobs (persistent, unlike the JSON file cache) */
async function saveToBlobCache(repo, result) {
  try {
    const store = getStore('score-cache');
    const record = {
      composite: result.composite,
      tier: result.tier,
      mode: result.mode,
      meta: {
        description: result.meta?.description || '',
        stars: result.meta?.stars || 0,
        forks: result.meta?.forks || 0,
        license: result.meta?.license || 'Unknown',
      },
      scannedAt: result.scannedAt,
    };
    await store.set(repo.toLowerCase(), JSON.stringify(record));
  } catch {}
}

async function saveToBlobHistory(repo, result) {
  try {
    const store = getStore('score-history');
    const date = new Date().toISOString().slice(0, 10);
    const entry = {
      repo,
      date,
      composite: result.composite,
      tier: result.tier,
      mode: result.mode,
      dimensions: result.dimensions || {},
      stars: result.meta?.stars || 0,
      isSkill: result.mode === 'skills',
      scannedAt: result.scannedAt,
    };
    await store.set(`${repo.toLowerCase()}:${date}`, JSON.stringify(entry));
  } catch {}
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://mcpskills.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  };

  // Initialize Blobs for API key validation
  connectLambda(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // --- Auth: Admin key OR Pro API key ---
  const adminKey = process.env.ADMIN_KEY;
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-API-Key'];
  let isAdmin = false;
  let isPro = false;
  let maxBatch = 0;

  if (adminKey && body.key && typeof body.key === 'string' && body.key.length === adminKey.length &&
      crypto.timingSafeEqual(Buffer.from(body.key), Buffer.from(adminKey))) {
    isAdmin = true;
    maxBatch = 10;
  } else if (apiKey) {
    const validation = await validateApiKey(apiKey);
    if (validation.valid && validation.tier === 'pro') {
      isPro = true;
      maxBatch = 5;
    } else if (validation.valid) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Batch scanning requires a Pro plan ($12/mo)' }) };
    } else {
      return { statusCode: 401, headers, body: JSON.stringify({ error: validation.reason }) };
    }
  } else if (adminKey) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin key or Pro API key required' }) };
  } else {
    // No ADMIN_KEY set — block batch scans entirely
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Batch scanning not configured' }) };
  }

  const repos = body.repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing repos array' }) };
  }

  const batch = repos.slice(0, maxBatch);
  const token = process.env.GITHUB_TOKEN || null;
  const results = [];

  for (const input of batch) {
    if (!input || typeof input !== 'string' || input.trim().length === 0) {
      results.push({ input, status: 'invalid' });
      continue;
    }

    try {
      const result = await scoreAny(input, token);
      if (result.error) {
        results.push({ input, status: 'error', error: result.error });
      } else {
        const cacheKey = result.repo || `npm:${result.package}`;
        cacheScore(result);
        await saveToBlobCache(cacheKey, result);
        await saveToBlobHistory(cacheKey, result);
        results.push({
          input,
          repo: result.repo || null,
          status: 'ok',
          score: result.composite,
          tier: result.tier,
          limited: result.limited || false,
        });

        // Consume credit for Pro users (not admin)
        if (isPro) await consumeCredit(apiKey);
      }
    } catch (e) {
      results.push({ input, status: 'error', error: e.message });
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      scanned: results.filter(r => r.status === 'ok').length,
      failed: results.filter(r => r.status !== 'ok').length,
      results,
      remaining: repos.length > maxBatch ? repos.slice(maxBatch) : [],
    }),
  };
};
