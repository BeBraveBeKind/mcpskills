/**
 * POST /.netlify/functions/monitor
 * Manage monitored repos for score change alerts.
 *
 * Paid-only: requires valid API key (X-API-Key header).
 *   - Single/10-pack: 3 watches
 *   - Pro: 10 watches
 *
 * Actions:
 *   { action: "watch", repo: "owner/repo", email: "user@example.com" }
 *   { action: "unwatch", repo: "owner/repo", email: "user@example.com" }
 *   { action: "list", email: "user@example.com" }
 *   { action: "check", email: "user@example.com" } — re-scan all watched repos
 *
 * Storage: Netlify Blobs ("monitors" store)
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreRepo } = require('../../lib/scorer');
const { cacheScore, loadScoreCache } = require('../../lib/recommender');
const { validateApiKey } = require('../../lib/auth');
const { sendScoreDropAlert } = require('../../lib/email');

const WATCH_LIMITS = { paid: 3, pro: 10 };

function monitorsStore() {
  return getStore('monitors');
}

exports.handler = async (event) => {
  connectLambda(event);

  const headers = {
    'Access-Control-Allow-Origin': 'https://mcpskills.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  // --- Auth: paid-only ---
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-API-Key'];
  if (!apiKey) {
    return {
      statusCode: 403, headers,
      body: JSON.stringify({
        error: 'Monitoring requires a paid plan',
        upgrade: 'Get a 10-pack ($29) for 3 watches or Pro ($12/mo) for 10 watches at https://mcpskills.io',
      }),
    };
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.valid) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: validation.reason }) };
  }

  const watchLimit = validation.tier === 'pro' ? WATCH_LIMITS.pro : WATCH_LIMITS.paid;

  // --- Parse body ---
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action, repo, email } = body;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
  if (!action || !email || !EMAIL_RE.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing action or valid email' }) };
  }
  if (repo && !REPO_RE.test(repo)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid repo format' }) };
  }

  // #9: Verify email matches API key's registered email
  const validation = await require('../../lib/auth').validateApiKey(apiKey);
  if (validation.valid && validation.email && validation.email !== email) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Email does not match API key' }) };
  }

  const store = monitorsStore();
  // #8: Hash email for Blob key instead of raw email
  const emailHash = require('crypto').createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 32);
  const userKey = `user:${emailHash}`;

  // Load user record
  let userData;
  try {
    const raw = await store.get(userKey);
    userData = raw ? JSON.parse(raw) : { email, repos: [], tier: validation.tier, createdAt: new Date().toISOString() };
  } catch {
    userData = { email, repos: [], tier: validation.tier, createdAt: new Date().toISOString() };
  }

  switch (action) {
    case 'watch': {
      if (!repo || !repo.includes('/')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid repo format' }) };
      }

      if (userData.repos.length >= watchLimit) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({
            error: `Watch limit reached (${watchLimit})`,
            limit: watchLimit,
            tier: validation.tier,
            upgrade: validation.tier !== 'pro' ? 'Upgrade to Pro ($12/mo) for 10 watches' : null,
          }),
        };
      }

      const existing = userData.repos.find(r => r.repo === repo);
      if (existing) {
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Already watching', repo }) };
      }

      // Get current score
      const cache = loadScoreCache();
      let currentScore = cache[repo]?.composite ?? null;
      let currentTier = cache[repo]?.tier ?? null;

      if (currentScore === null) {
        const token = process.env.GITHUB_TOKEN || null;
        try {
          const [owner, repoName] = repo.split('/');
          const result = await scoreRepo(owner, repoName, token);
          if (!result.error) {
            currentScore = result.composite;
            currentTier = result.tier;
            cacheScore(result);
          }
        } catch {}
      }

      userData.repos.push({
        repo,
        addedAt: new Date().toISOString(),
        baselineScore: currentScore,
        baselineTier: currentTier,
        lastChecked: new Date().toISOString(),
        lastScore: currentScore,
        lastTier: currentTier,
      });

      await store.set(userKey, JSON.stringify(userData));

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          message: `Now watching ${repo}`,
          currentScore,
          currentTier,
          totalWatched: userData.repos.length,
          watchLimit,
        }),
      };
    }

    case 'unwatch': {
      userData.repos = userData.repos.filter(r => r.repo !== repo);
      await store.set(userKey, JSON.stringify(userData));
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ message: `Unwatched ${repo}`, totalWatched: userData.repos.length }),
      };
    }

    case 'list': {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          email,
          repos: userData.repos.map(r => ({
            repo: r.repo,
            baselineScore: r.baselineScore,
            lastScore: r.lastScore,
            lastTier: r.lastTier,
            lastChecked: r.lastChecked,
            change: r.lastScore != null && r.baselineScore != null
              ? Math.round((r.lastScore - r.baselineScore) * 100) / 100
              : null,
          })),
          totalWatched: userData.repos.length,
          watchLimit,
        }),
      };
    }

    case 'check': {
      if (userData.repos.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'No repos watched', checked: 0, changes: [] }) };
      }

      const token = process.env.GITHUB_TOKEN || null;
      const changes = [];

      for (const entry of userData.repos) {
        const [owner, repoName] = entry.repo.split('/');
        try {
          const result = await scoreRepo(owner, repoName, token);
          if (result.error) continue;

          cacheScore(result);
          const oldScore = entry.lastScore;
          const newScore = result.composite;
          const scoreDelta = oldScore != null ? Math.round((newScore - oldScore) * 100) / 100 : null;

          const oldTier = entry.lastTier;
          entry.lastScore = newScore;
          entry.lastTier = result.tier;
          entry.lastChecked = new Date().toISOString();

          if (scoreDelta !== null && (Math.abs(scoreDelta) >= 0.3 || oldTier !== result.tier)) {
            changes.push({
              repo: entry.repo,
              oldScore, newScore,
              delta: scoreDelta,
              oldTier,
              newTier: result.tier,
              tierChanged: oldTier !== result.tier,
            });
          }
        } catch {}
      }

      await store.set(userKey, JSON.stringify(userData));

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          checked: userData.repos.length,
          changes,
          message: changes.length > 0
            ? `${changes.length} repo(s) changed significantly`
            : 'No significant changes detected',
        }),
      };
    }

    default:
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
  }
};
