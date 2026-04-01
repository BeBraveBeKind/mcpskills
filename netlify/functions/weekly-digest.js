/**
 * Scheduled Function: weekly-digest
 * Runs Sunday 6pm UTC — generates a structured analysis of all scored repos.
 *
 * Reads from Blob stores:
 *   - score-cache: latest scores for all known repos
 *   - score-history: daily snapshots for trend analysis
 *
 * Produces a findings report saved to Blob store "weekly-digests"
 * keyed by week (digest:YYYY-WNN).
 *
 * Report includes:
 *   - Total repos scored, tier distribution
 *   - New repos added this week
 *   - Score changes (biggest movers up/down)
 *   - Skills Mode breakdown (how many are AI skills vs standard)
 *   - Security findings summary (blocked, low-solid repos)
 *   - Top/bottom repos by score
 */

const { connectLambda, getStore } = require('@netlify/blobs');

function getWeekKey() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `digest:${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function getDatesThisWeek() {
  const dates = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

exports.handler = async (event) => {
  connectLambda(event);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const startTime = Date.now();

  try {
    // --- Load all current scores ---
    const cacheStore = getStore('score-cache');
    const { blobs: cacheBlobs } = await cacheStore.list();

    const repos = [];
    for (const blob of cacheBlobs) {
      try {
        const raw = await cacheStore.get(blob.key);
        if (!raw) continue;
        const record = JSON.parse(raw);
        repos.push({ repo: blob.key, ...record });
      } catch {}
    }

    // --- Tier distribution ---
    const tierCounts = { verified: 0, established: 0, new: 0, blocked: 0 };
    const modeCounts = { skills: 0, standard: 0 };
    let totalScore = 0;

    for (const r of repos) {
      tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
      modeCounts[r.mode === 'skills' ? 'skills' : 'standard']++;
      totalScore += r.composite || 0;
    }

    const avgScore = repos.length > 0 ? +(totalScore / repos.length).toFixed(2) : 0;

    // --- Top and bottom repos ---
    const sorted = [...repos].sort((a, b) => (b.composite || 0) - (a.composite || 0));
    const top5 = sorted.slice(0, 5).map(r => ({ repo: r.repo, score: r.composite, tier: r.tier }));
    const bottom5 = sorted.slice(-5).reverse().map(r => ({ repo: r.repo, score: r.composite, tier: r.tier }));

    // --- Security concerns (blocked or low solid) ---
    const concerns = repos.filter(r => r.tier === 'blocked' || (r.composite || 0) < 4.0);

    // --- Check for new repos this week (scored in last 7 days) ---
    const weekDates = getDatesThisWeek();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffISO = cutoff.toISOString();

    const newThisWeek = repos.filter(r => r.scannedAt && r.scannedAt >= cutoffISO);

    // --- Score changes: compare this week's scores to history from 7 days ago ---
    const historyStore = getStore('score-history');
    const weekAgoDate = weekDates[0]; // 7 days ago
    const movers = [];

    for (const r of repos) {
      try {
        const histKey = `${r.repo}:${weekAgoDate}`;
        const histRaw = await historyStore.get(histKey);
        if (!histRaw) continue;
        const hist = JSON.parse(histRaw);
        const delta = (r.composite || 0) - (hist.composite || 0);
        if (Math.abs(delta) >= 0.3) {
          movers.push({
            repo: r.repo,
            from: hist.composite,
            to: r.composite,
            delta: +delta.toFixed(2),
            direction: delta > 0 ? 'up' : 'down',
          });
        }
      } catch {}

      // Budget check — don't exceed 8s
      if (Date.now() - startTime > 8000) break;
    }

    movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    // --- Build digest ---
    const digest = {
      weekKey: getWeekKey(),
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      summary: {
        totalRepos: repos.length,
        avgScore,
        tierDistribution: tierCounts,
        modeDistribution: modeCounts,
      },
      newThisWeek: newThisWeek.map(r => ({ repo: r.repo, score: r.composite, tier: r.tier })),
      topRepos: top5,
      bottomRepos: bottom5,
      securityConcerns: concerns.map(r => ({ repo: r.repo, score: r.composite, tier: r.tier })),
      biggestMovers: movers.slice(0, 10),
      // Narrative hooks for content generation
      narrativeHooks: [],
    };

    // Generate narrative hooks
    if (newThisWeek.length > 0) {
      digest.narrativeHooks.push(`${newThisWeek.length} new repos scored this week`);
    }
    if (movers.filter(m => m.direction === 'down').length > 0) {
      const drops = movers.filter(m => m.direction === 'down');
      digest.narrativeHooks.push(`${drops.length} repos saw score drops — investigate for regressions`);
    }
    if (tierCounts.blocked > 0) {
      digest.narrativeHooks.push(`${tierCounts.blocked} repos currently blocked — security concerns detected`);
    }
    const skillPct = repos.length > 0 ? Math.round((modeCounts.skills / repos.length) * 100) : 0;
    digest.narrativeHooks.push(`${skillPct}% of scored repos are AI skills/MCP servers (Skills Mode)`);
    digest.narrativeHooks.push(`Average trust score across ${repos.length} repos: ${avgScore}/10`);

    // --- Save digest ---
    const digestStore = getStore('weekly-digests');
    await digestStore.set(digest.weekKey, JSON.stringify(digest, null, 2));

    // Also save as "latest" for easy retrieval
    await digestStore.set('latest', JSON.stringify(digest, null, 2));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(digest, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Digest generation failed', details: err.message }),
    };
  }
};
