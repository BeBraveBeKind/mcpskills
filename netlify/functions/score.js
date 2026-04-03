/**
 * POST /.netlify/functions/score
 * Score any AI skill, MCP server, or GitHub repo.
 *
 * Body: { "repo": "owner/repo" }
 *   — or any supported format:
 *     owner/repo, GitHub URL, npm:@scope/package, Smithery URL, OpenClaw URL
 *
 * Response modes:
 *   - Human free (no key, browser): tier + composite + meta
 *   - Agent free (no key, Accept: application/json): safe + recommendation + tier + score + flags
 *   - Paid (valid API key): full 14-signal report
 *
 * Rate limits:
 *   - Human free: 3/day per IP
 *   - Agent free: 20/day per IP
 *   - Paid: per credit or unlimited (Pro)
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreAny } = require('../../lib/score-any');
const { recommend } = require('../../lib/recommender');
const {
  authenticateRequest,
  consumeCredit,
  buildAgentResponse,
  buildHumanFreeResponse,
  buildFullResponse,
} = require('../../lib/auth');

exports.handler = async (event) => {
  // Initialize Blobs for rate limiting + API key validation
  connectLambda(event);
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    };
  }

  // --- Auth + Rate Limiting ---
  const auth = await authenticateRequest(event);

  if (!auth.authenticated) {
    const status = auth.errorCode || 429;
    const response = { error: auth.error };
    if (auth.limit) response.limit = auth.limit;
    if (auth.resetAt) response.resetAt = auth.resetAt;
    if (status === 429) {
      response.upgrade = 'Get unlimited scans at https://mcpskills.io — $9 single report or $12/mo Pro';
    }
    return { statusCode: status, headers, body: JSON.stringify(response) };
  }

  // --- Parse Body ---
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const rawInput = body.repo;
  if (!rawInput || typeof rawInput !== 'string' || rawInput.trim().length === 0 || rawInput.length > 500) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Missing "repo" field. Accepted formats: owner/repo, GitHub URL, npm:@scope/package, Smithery URL, or OpenClaw URL.',
      }),
    };
  }

  // --- Score via unified entry point ---
  const token = process.env.GITHUB_TOKEN || null;

  try {
    const result = await scoreAny(rawInput, token);

    if (result.error) {
      const status = result.inputType === 'invalid' ? 400 : 404;
      return {
        statusCode: status,
        headers,
        body: JSON.stringify({ error: result.error, inputType: result.inputType }),
      };
    }

    const repoPath = result.repo || `npm:${result.package}`;

    // Attach recommendations (only for full scores with a resolved repo)
    if (result.repo) {
      try {
        const [owner, repo] = result.repo.split('/');
        result.recommendations = recommend(owner, repo, result);
      } catch {
        result.recommendations = null;
      }
    }

    // --- Persist to Blob stores ---
    try {
      const cacheStore = getStore('score-cache');
      const cacheRecord = {
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
      };
      await cacheStore.set(repoPath.toLowerCase(), JSON.stringify(cacheRecord));

      const historyStore = getStore('score-history');
      const date = new Date().toISOString().slice(0, 10);
      const historyEntry = {
        repo: repoPath,
        date,
        composite: result.composite,
        tier: result.tier,
        mode: result.mode,
        dimensions: result.dimensions || {},
        stars: result.meta?.stars || 0,
        isSkill: result.mode === 'skills',
        scannedAt: result.scannedAt,
      };
      await historyStore.set(`${repoPath.toLowerCase()}:${date}`, JSON.stringify(historyEntry));
    } catch {}

    // --- Check certification status ---
    let certified = false;
    try {
      const certStore = getStore('certifications');
      const raw = await certStore.get(`cert:${repoPath}`);
      if (raw) {
        const record = JSON.parse(raw);
        certified = record.status === 'certified';
      }
    } catch {}
    result.certified = certified;

    // --- Consume credit for paid users ---
    if (auth.tier !== 'free' && auth.key) {
      await consumeCredit(auth.key);
    }

    // --- Build response based on mode + tier ---
    let responseData;

    if (auth.tier === 'pro' || auth.tier === 'paid') {
      // Full report for paid users
      responseData = buildFullResponse(result);
    } else if (auth.mode === 'agent') {
      // Compact agent response for free agent callers
      responseData = buildAgentResponse(result);
    } else {
      // Minimal human response for free web users
      responseData = buildHumanFreeResponse(result);
    }

    // Add rate limit info for free users
    if (auth.tier === 'free' && auth.remaining !== undefined) {
      responseData._rateLimit = {
        remaining: auth.remaining,
        mode: auth.mode,
      };
    }

    // --- Audit log ---
    try {
      const auditStore = getStore('audit-log');
      const now = new Date();
      const dayKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
      // Hash IP for privacy — just first 8 chars of a simple hash
      const ipHash = Array.from(ip).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0).toString(16).slice(-8);
      const keyPrefix = auth.key ? auth.key.slice(0, 12) + '...' : null;

      const entry = {
        ts: now.toISOString(),
        repo: repoPath,
        inputType: result.inputType || 'github',
        rawInput: result.inputType !== 'github' ? rawInput.slice(0, 200) : undefined,
        tier: auth.tier,
        mode: auth.mode,
        keyPrefix,
        ipHash,
        resultTier: result.tier,
        score: result.composite,
        certified,
        limited: result.limited || false,
      };

      // Append to daily log (read-modify-write)
      const logKey = `log:${dayKey}`;
      let entries = [];
      try {
        const existing = await auditStore.get(logKey);
        if (existing) entries = JSON.parse(existing);
      } catch {}
      entries.push(entry);
      await auditStore.set(logKey, JSON.stringify(entries));
    } catch {
      // Audit logging is best-effort — never block the response
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(responseData, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal scoring error' }),
    };
  }
};
