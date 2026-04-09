/**
 * lib/auto-certify.js — Auto-certification helper
 *
 * Shared by netlify/functions/nightly-crawl.js (scores new/refreshed repos)
 * and netlify/functions/badge.js (scores repos discovered via badge embeds).
 *
 * Only auto-certifies repos that meet the same requirements as the manual
 * application flow in certify.js:
 *   - composite >= 7.0
 *   - dimensions.solid >= 5.0
 *   - no disqualifiers
 *   - >= 8 sufficient signals
 *   - not a partial/limited score
 *
 * Never overwrites an existing cert record — human-applied certs stay in
 * their current state. Only promotes never-applied repos to 'certified'
 * with certifiedBy='auto' so they can be filtered/audited later.
 */

const { getStore } = require('@netlify/blobs');

const REQUIREMENTS = {
  minScore: 7.0,
  minSolid: 5.0,
  minSignals: 8,
};

/**
 * Fetch a GitHub user's public email address from the REST API.
 * Returns null if the user doesn't have a public email, the request fails,
 * or the input is not a GitHub repo (e.g. npm-only package).
 *
 * Uses GITHUB_TOKEN when available (5000/hr) to avoid the 60/hr unauth limit.
 */
async function fetchGitHubOwnerEmail(cacheKey) {
  // Only GitHub repos have owners we can look up (skip npm:xxx and partial keys)
  if (!cacheKey || cacheKey.startsWith('npm:') || !cacheKey.includes('/')) return null;
  const owner = cacheKey.split('/')[0];
  if (!owner) return null;

  const token = process.env.GITHUB_TOKEN || null;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'mcpskills-auto-cert',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, {
      headers,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const data = await res.json();
    // GitHub returns null for users who don't expose their email publicly.
    // Basic sanity check: must contain @ and be a string.
    if (typeof data.email === 'string' && data.email.includes('@')) {
      return data.email;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Post-certification hook — runs AFTER the cert record is persisted.
 * Fire-and-forget: every call wrapped in try/catch so a failure here
 * never blocks the cert write upstream.
 *
 * Currently: fetches the repo owner's public GitHub email and sends the
 * auto-cert congratulations email (via lib/email.js). Marks the cert
 * record with `ownerNotified: true | 'no_email' | 'failed'` so retries
 * don't re-spam owners.
 */
async function onCertified(cacheKey, result) {
  try {
    const store = getStore('certifications');
    const certKey = `cert:${cacheKey}`;
    const raw = await store.get(certKey);
    if (!raw) return;
    const record = JSON.parse(raw);

    // Already notified — skip (handles re-entry from multiple call sites)
    if (record.ownerNotified != null) return;

    const email = await fetchGitHubOwnerEmail(cacheKey);
    if (!email) {
      record.ownerNotified = 'no_email';
      await store.set(certKey, JSON.stringify(record));
      return;
    }

    // Lazy-require to avoid a circular dep risk with any future email.js changes
    // and to ensure this file stays importable in test contexts without Resend.
    const { sendAutoCertEmail } = require('./email');
    const sendResult = await sendAutoCertEmail({
      email,
      repo: cacheKey,
      score: result?.composite,
    });

    record.ownerNotified = sendResult?.sent === true ? true : 'failed';
    record.ownerEmail = email; // for audit / future unsubscribe support
    record.log = record.log || [];
    record.log.push({
      action: 'owner_notified',
      at: new Date().toISOString(),
      by: 'auto-certify',
      sent: sendResult?.sent === true,
      reason: sendResult?.reason || null,
    });
    await store.set(certKey, JSON.stringify(record));
  } catch {
    // Never let this block the caller — cert write already succeeded.
  }
}

function isEligible(result) {
  if (!result || result.error) return false;
  if (result.mode === 'partial' || result.limited) return false;
  if (result.composite == null || result.composite < REQUIREMENTS.minScore) return false;
  const solid = result.dimensions?.solid;
  if (solid == null || solid < REQUIREMENTS.minSolid) return false;
  if (result.disqualifiers && result.disqualifiers.length > 0) return false;
  const signalCount = result.signals
    ? Object.values(result.signals).filter(v => v != null).length
    : 0;
  if (signalCount < REQUIREMENTS.minSignals) return false;
  return true;
}

/**
 * Attempt to auto-certify a scored result.
 *
 * @param {string} cacheKey - Lowercased blob key (owner/repo or npm:pkg)
 * @param {object} result - Full scoring result from scoreAny()
 * @param {string} triggeredBy - Which path issued the cert (e.g. "nightly-crawl", "badge")
 * @returns {Promise<boolean>} - true if a new cert was issued
 */
async function tryAutoCertify(cacheKey, result, triggeredBy = 'auto') {
  try {
    if (!isEligible(result)) return false;

    const store = getStore('certifications');
    const certKey = `cert:${cacheKey}`;

    // Don't touch repos that already have any cert record.
    const existing = await store.get(certKey);
    if (existing) return false;

    const now = new Date().toISOString();
    const signalCount = result.signals
      ? Object.values(result.signals).filter(v => v != null).length
      : 0;

    const record = {
      repo: cacheKey,
      email: null,
      status: 'certified',
      score: result.composite,
      tier: result.tier,
      solid: result.dimensions?.solid,
      certifiedBy: 'auto',
      appliedAt: now,
      certifiedAt: now,
      log: [
        { action: 'auto_certified', at: now, by: triggeredBy, score: result.composite, signalCount },
      ],
    };
    await store.set(certKey, JSON.stringify(record));

    // Fire-and-forget owner notification. We await it so the caller can
    // rely on the cert state being fully resolved, but onCertified() is
    // wrapped in its own try/catch and will never throw — so even if
    // GitHub API or Resend is down, the cert write above is already
    // committed and this function still returns true.
    await onCertified(cacheKey, result);

    return true;
  } catch {
    return false;
  }
}

module.exports = { tryAutoCertify, isEligible, REQUIREMENTS, onCertified };
