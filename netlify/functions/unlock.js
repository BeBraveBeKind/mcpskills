/**
 * POST /.netlify/functions/unlock
 * Verify a purchase session and return the full report or API key.
 *
 * Body: { "sessionId": "uuid" }
 *
 * Uses connectLambda for Netlify Blobs access in Lambda compat mode.
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreAny } = require('../../lib/score-any');
const { recommend } = require('../../lib/recommender');

exports.handler = async (event, context) => {
  // Initialize Blobs from Lambda context
  connectLambda(event);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://mcpskills.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const sessionId = body.sessionId;
  if (!sessionId || sessionId.length < 10) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing sessionId' }) };
  }

  try {
    const store = getStore('purchases');
    const raw = await store.get(`token:${sessionId}`);

    if (!raw) {
      return { statusCode: 404, headers, body: JSON.stringify({ status: 'pending' }) };
    }

    const record = JSON.parse(raw);

    // Check expiry
    if (new Date(record.expiresAt) < new Date()) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Token expired' }) };
    }

    // Check if already consumed
    if (record.consumed) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Token already used' }) };
    }

    // Mark as consumed — NOTE: not atomic (TOCTOU). Concurrent requests could both
    // read consumed=false. Risk is limited: duplicate report delivery, not financial loss.
    record.consumed = true;
    record.consumedAt = new Date().toISOString();
    await store.set(`token:${sessionId}`, JSON.stringify(record));

    // Handle different purchase types
    if (record.type === '10-pack' || record.type === 'pro') {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          status: 'unlocked',
          type: record.type,
          apiKey: record.apiKey,
          email: record.email,
          message: record.type === 'pro'
            ? 'Pro plan activated! Unlimited scans, batch API, and monitoring.'
            : '10-pack activated! 10 full reports ready to use.',
        }),
      };
    }

    // Single report — score the repo/package and return full data
    const repo = record.repo;
    if (!repo || typeof repo !== 'string' || repo.trim().length === 0) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ status: 'unlocked', type: 'single', error: 'No repo in purchase record' }),
      };
    }

    const token = process.env.GITHUB_TOKEN || null;
    const result = await scoreAny(repo, token);

    if (result.error) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ status: 'unlocked', type: 'single', error: result.error }),
      };
    }

    try {
      const [owner, repoName] = (result.repo || repo).split('/');
      if (owner && repoName) result.recommendations = recommend(owner, repoName, result);
    } catch { /* skip */ }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ status: 'unlocked', type: 'single', report: result }),
    };

  } catch (err) {
    console.error('Unlock error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
