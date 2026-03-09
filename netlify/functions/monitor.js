/**
 * POST /.netlify/functions/monitor
 * Manage monitored repos for score change alerts.
 *
 * Actions:
 *   { action: "watch", repo: "owner/repo", email: "user@example.com" }
 *   { action: "unwatch", repo: "owner/repo", email: "user@example.com" }
 *   { action: "list", email: "user@example.com" }
 *   { action: "check", email: "user@example.com" }  — re-scan all watched repos, return changes
 *
 * Storage: data/monitors.json (will migrate to Supabase/Blobs at scale)
 */

const fs = require('fs');
const path = require('path');
const { scoreRepo } = require('../../lib/scorer');
const { cacheScore, loadScoreCache } = require('../../lib/recommender');

const MONITORS_PATH = path.join(__dirname, '..', '..', 'data', 'monitors.json');

function loadMonitors() {
  try {
    return JSON.parse(fs.readFileSync(MONITORS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveMonitors(monitors) {
  fs.writeFileSync(MONITORS_PATH, JSON.stringify(monitors, null, 2));
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
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

  const { action, repo, email } = body;
  if (!action || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing action or email' }) };
  }

  const monitors = loadMonitors();

  switch (action) {
    case 'watch': {
      if (!repo || !repo.includes('/')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid repo format' }) };
      }

      if (!monitors[email]) monitors[email] = { repos: [], createdAt: new Date().toISOString() };

      // Cap at 20 repos per email on free tier
      if (monitors[email].repos.length >= 20) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Free tier limit: 20 repos. Upgrade for unlimited.' }) };
      }

      const existing = monitors[email].repos.find(r => r.repo === repo);
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
          const result = await scoreRepo(repo.split('/')[0], repo.split('/')[1], token);
          if (!result.error) {
            currentScore = result.composite;
            currentTier = result.tier;
            cacheScore(result);
          }
        } catch {}
      }

      monitors[email].repos.push({
        repo,
        addedAt: new Date().toISOString(),
        baselineScore: currentScore,
        baselineTier: currentTier,
        lastChecked: new Date().toISOString(),
        lastScore: currentScore,
        lastTier: currentTier,
      });

      saveMonitors(monitors);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: `Now watching ${repo}`,
          currentScore,
          currentTier,
          totalWatched: monitors[email].repos.length,
        }),
      };
    }

    case 'unwatch': {
      if (!monitors[email]) {
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Nothing to unwatch' }) };
      }
      monitors[email].repos = monitors[email].repos.filter(r => r.repo !== repo);
      saveMonitors(monitors);
      return { statusCode: 200, headers, body: JSON.stringify({ message: `Unwatched ${repo}` }) };
    }

    case 'list': {
      const userMonitors = monitors[email]?.repos || [];
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          email,
          repos: userMonitors.map(r => ({
            repo: r.repo,
            baselineScore: r.baselineScore,
            lastScore: r.lastScore,
            lastTier: r.lastTier,
            lastChecked: r.lastChecked,
            change: r.lastScore != null && r.baselineScore != null
              ? Math.round((r.lastScore - r.baselineScore) * 100) / 100
              : null,
          })),
          totalWatched: userMonitors.length,
        }),
      };
    }

    case 'check': {
      const userRepos = monitors[email]?.repos || [];
      if (userRepos.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'No repos watched', changes: [] }) };
      }

      const token = process.env.GITHUB_TOKEN || null;
      const changes = [];

      for (const entry of userRepos) {
        const [owner, repoName] = entry.repo.split('/');
        try {
          const result = await scoreRepo(owner, repoName, token);
          if (result.error) continue;

          cacheScore(result);
          const oldScore = entry.lastScore;
          const newScore = result.composite;
          const scoreDelta = oldScore != null ? Math.round((newScore - oldScore) * 100) / 100 : null;

          entry.lastScore = newScore;
          entry.lastTier = result.tier;
          entry.lastChecked = new Date().toISOString();

          if (scoreDelta !== null && Math.abs(scoreDelta) >= 0.3) {
            changes.push({
              repo: entry.repo,
              oldScore,
              newScore,
              delta: scoreDelta,
              oldTier: entry.lastTier,
              newTier: result.tier,
              tierChanged: entry.lastTier !== result.tier,
              direction: scoreDelta > 0 ? 'improved' : 'declined',
            });
          }
        } catch {}
      }

      saveMonitors(monitors);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          checked: userRepos.length,
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
