/**
 * Scheduled Function: nightly-crawl
 * Runs at 2am UTC daily — 6 hours before daily-scan (8am).
 *
 * Three jobs in priority order (within 10s Netlify timeout):
 *   1. DISCOVER — find new repos from MCP Registry + GitHub search
 *   2. SCORE — score up to 5 new discoveries
 *   3. REFRESH — re-score up to 3 stale cached repos (oldest first)
 *
 * All scores stored in "score-history" Blob store for trend analysis.
 * New discoveries + refreshed scores stored in "score-cache" Blob store
 * for fast badge/scan lookups.
 *
 * Budget: ~8s usable (10s timeout - 2s overhead)
 *   - Discovery: ~3s (3 parallel API calls)
 *   - Scoring: ~1s per repo (GitHub API)
 *   - Target: 5 new + 3 refresh = 8 repos per night
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreAny } = require('../../lib/score-any');
const { discoverNewRepos } = require('../../lib/crawler');

function scoreCacheStore() {
  return getStore('score-cache');
}

function scoreHistoryStore() {
  return getStore('score-history');
}

function crawlStatsStore() {
  return getStore('crawl-stats');
}

async function loadKnownRepos() {
  const store = scoreCacheStore();
  const known = new Set();
  try {
    const { blobs } = await store.list();
    for (const b of blobs) {
      known.add(b.key.toLowerCase());
    }
  } catch {}
  return known;
}

async function saveScore(cacheKey, result) {
  const store = scoreCacheStore();
  const record = {
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
  await store.set(cacheKey.toLowerCase(), JSON.stringify(record));
}

async function saveHistory(cacheKey, result) {
  const store = scoreHistoryStore();
  const date = new Date().toISOString().slice(0, 10);
  const key = `${cacheKey.toLowerCase()}:${date}`;

  const entry = {
    repo: result.repo || null,
    package: result.package || null,
    date,
    composite: result.composite,
    tier: result.tier,
    mode: result.mode,
    limited: result.limited || false,
    dimensions: result.dimensions || {},
    stars: result.meta?.stars || 0,
    isSkill: result.mode === 'skills',
    scannedAt: result.scannedAt,
  };

  await store.set(key, JSON.stringify(entry));
}

async function getStaleRepos(limit = 3) {
  const store = scoreCacheStore();
  const stale = [];

  try {
    const { blobs } = await store.list();
    const entries = [];

    // Sample up to 20 entries to find stalest (avoid loading all)
    const sample = blobs.slice(0, Math.min(blobs.length, 40));
    for (const b of sample) {
      try {
        const raw = await store.get(b.key);
        if (!raw) continue;
        const record = JSON.parse(raw);
        entries.push({ repo: b.key, scannedAt: record.scannedAt || '2020-01-01' });
      } catch {}
    }

    // Sort by scannedAt ascending (oldest first)
    entries.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
    return entries.slice(0, limit).map(e => e.repo);
  } catch {}

  return stale;
}

exports.handler = async (event) => {
  connectLambda(event);

  const startTime = Date.now();
  const token = process.env.GITHUB_TOKEN || null;
  const BUDGET_MS = 8000; // Stay under 10s timeout

  const stats = {
    discovered: 0,
    scored: 0,
    refreshed: 0,
    errors: 0,
    errorDetails: [],
    sources: { registry: 0, github: 0 },
    hasToken: !!token,
    startedAt: new Date().toISOString(),
  };

  console.log('Nightly crawl started');

  // --- Phase 1: DISCOVER ---
  let newRepos = [];
  let npmOnlyPackages = [];
  try {
    const knownRepos = await loadKnownRepos();
    stats.knownBefore = knownRepos.size;
    const discovered = await discoverNewRepos(knownRepos, token, 20);
    newRepos = discovered.repos;
    npmOnlyPackages = discovered.npmOnlyPackages;
    stats.discovered = newRepos.length;
    stats.npmDiscovered = npmOnlyPackages.length;
  } catch (err) {
    console.error('Discovery failed:', err.message);
    stats.errors++;
  }

  // --- Phase 2: SCORE new discoveries (max 5 repos + 3 npm packages per run) ---
  let scoreBudget = 5;
  for (const repo of newRepos) {
    if (scoreBudget <= 0 || Date.now() - startTime > BUDGET_MS) {
      console.log('Budget exceeded, stopping scoring');
      break;
    }

    // Quick existence check — skip dead repos fast
    const [owner, repoName] = repo.split('/');
    if (!owner || !repoName) continue;

    try {
      const ghHeaders = { 'User-Agent': 'mcpskills-crawler' };
      if (token) ghHeaders['Authorization'] = `Bearer ${token}`;
      const check = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, { method: 'HEAD', headers: ghHeaders });
      if (!check.ok) {
        stats.errorDetails.push({ repo, error: `HEAD check: ${check.status}` });
        stats.errors++;
        continue;
      }
    } catch {}

    try {
      const result = await scoreAny(repo, token);
      if (result.error) {
        console.warn(`Failed to score ${repo}: ${result.error}`);
        stats.errors++;
        stats.errorDetails.push({ repo, error: result.error });
        continue;
      }

      await Promise.all([
        saveScore(repo, result),
        saveHistory(repo, result),
      ]);

      stats.scored++;
      scoreBudget--;
      console.log(`Scored: ${repo} → ${result.composite} (${result.tier})`);
    } catch (err) {
      console.error(`Error scoring ${repo}:`, err.message);
      stats.errors++;
      stats.errorDetails.push({ repo, error: err.message });
    }
  }

  // Score npm-only packages (partial scores, max 3 per run)
  let npmBudget = 3;
  stats.npmScored = 0;
  for (const pkg of npmOnlyPackages) {
    if (npmBudget <= 0 || Date.now() - startTime > BUDGET_MS) break;

    try {
      const result = await scoreAny(`npm:${pkg}`, token, { skipPartial: false });
      if (result.error) {
        stats.errorDetails.push({ input: `npm:${pkg}`, error: result.error });
        continue;
      }

      const cacheKey = `npm:${pkg}`;
      await Promise.all([
        saveScore(cacheKey, result),
        saveHistory(cacheKey, result),
      ]);

      stats.npmScored++;
      npmBudget--;
      console.log(`Scored (partial): npm:${pkg} → ${result.composite} (${result.tier})`);
    } catch (err) {
      console.error(`Error scoring npm:${pkg}:`, err.message);
    }
  }

  // --- Phase 3: REFRESH stale cache entries ---
  if (Date.now() - startTime < BUDGET_MS - 2000) {
    try {
      const staleRepos = await getStaleRepos(3);

      for (const cacheKey of staleRepos) {
        if (Date.now() - startTime > BUDGET_MS) break;

        try {
          // cacheKey may be "owner/repo" or "npm:packagename"
          const input = cacheKey.startsWith('npm:') ? cacheKey : cacheKey;
          const result = await scoreAny(input, token);
          if (result.error) continue;

          await Promise.all([
            saveScore(cacheKey, result),
            saveHistory(cacheKey, result),
          ]);

          stats.refreshed++;
          console.log(`Refreshed: ${cacheKey} → ${result.composite}`);
        } catch (err) {
          console.error(`Error refreshing ${cacheKey}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Refresh phase failed:', err.message);
    }
  }

  // --- Save crawl stats ---
  stats.completedAt = new Date().toISOString();
  stats.durationMs = Date.now() - startTime;

  try {
    const statsStore = crawlStatsStore();
    const date = new Date().toISOString().slice(0, 10);
    await statsStore.set(`crawl:${date}`, JSON.stringify(stats));
  } catch {}

  console.log('Nightly crawl summary:', JSON.stringify(stats));

  return {
    statusCode: 200,
    body: JSON.stringify(stats),
  };
};
