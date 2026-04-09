/**
 * POST /api/limit-capture
 *
 * Free-tier lead capture. When a rate-limited free user drops their email,
 * we send them ONE full report for free and store their lead in the
 * `free-leads` blob store. This is the bridge between the free tier's
 * rate limit and monetization.
 *
 * Anti-abuse:
 *   - IP rate-limited at 3/hour via the existing capture mode in lib/auth.js
 *     so this endpoint can never be used as an unlimited-scan bypass.
 *   - Email format validated (basic regex).
 *   - Repo input reuses scoreAny() resolver, so the same validation applies.
 *   - Existing leads are upserted (not duplicated) and marked with a new
 *     repo history entry so we still know which repos triggered capture.
 *
 * Lead shape:
 *   lead:{lowercase-email} → {
 *     email, firstRepo, capturedAt, source, converted, history: [{repo, at}]
 *   }
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreAny } = require('../../lib/score-any');
const { hashIP, checkRateLimit } = require('../../lib/auth');
const { sendFreeSampleReport } = require('../../lib/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getLead(email) {
  try {
    const store = getStore('free-leads');
    const raw = await store.get(`lead:${email}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function upsertLead(email, repo) {
  try {
    const store = getStore('free-leads');
    const key = `lead:${email}`;
    const existing = await getLead(email);
    const now = new Date().toISOString();
    if (existing) {
      const history = Array.isArray(existing.history) ? existing.history : [];
      // Cap history at 10 entries to keep the blob small
      history.push({ repo, at: now });
      const trimmed = history.slice(-10);
      const updated = {
        ...existing,
        history: trimmed,
        lastCapturedAt: now,
      };
      await store.set(key, JSON.stringify(updated));
      return { record: updated, isNew: false };
    }
    const record = {
      email,
      firstRepo: repo,
      capturedAt: now,
      lastCapturedAt: now,
      source: 'rate-limit',
      converted: false,
      history: [{ repo, at: now }],
    };
    await store.set(key, JSON.stringify(record));
    return { record, isNew: true };
  } catch (err) {
    console.warn('upsertLead failed:', err.message);
    return { record: null, isNew: false };
  }
}

exports.handler = async (event) => {
  connectLambda(event);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  // --- Rate limit this endpoint aggressively by IP ---
  const ipHash = hashIP(event);
  const rateCheck = await checkRateLimit(ipHash, 'capture');
  if (!rateCheck.allowed) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({
        error: 'Too many capture attempts from this IP. Try again in an hour.',
        resetAt: rateCheck.resetAt,
      }),
    };
  }

  // --- Parse + validate body ---
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const email = (body.email || '').trim().toLowerCase();
  const rawRepo = (body.repo || '').trim();

  if (!email || !EMAIL_RE.test(email) || email.length > 200) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email' }) };
  }
  if (!rawRepo || rawRepo.length > 500) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing repo' }) };
  }

  // --- Score the repo (full mode — we want the gift to be $9 quality) ---
  const token = process.env.GITHUB_TOKEN || null;
  let result;
  try {
    result = await scoreAny(rawRepo, token);
    if (result.error) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: result.error }) };
    }
  } catch {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to score repo' }) };
  }

  const repoPath = result.repo || (result.package ? `npm:${result.package}` : rawRepo);

  // --- Persist lead ---
  const { record, isNew } = await upsertLead(email, repoPath);

  // --- Send gift report (fire-and-forget — lead is persisted even if email fails) ---
  let emailResult;
  try {
    emailResult = await sendFreeSampleReport({ email, repo: repoPath, result });
  } catch (err) {
    emailResult = { sent: false, reason: err.message };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      leadCaptured: !!record,
      newLead: isNew,
      emailSent: emailResult?.sent === true,
      message: emailResult?.sent
        ? 'Check your inbox — your full report is on the way.'
        : 'Lead captured, but report delivery failed. We\'ll retry shortly.',
    }),
  };
};
