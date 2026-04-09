/**
 * lib/source-stats.js — Discovery source quality feedback
 *
 * The nightly crawler pulls from 5 sources (MCP Registry, GitHub topics,
 * GitHub keywords, npm, Smithery). This module records per-source quality
 * metrics (found count, scored-over-7 count, average composite) and
 * computes a bias ordering so the crawler can prioritize high-yielding
 * sources within its 8s budget.
 *
 * Blob store: `source-stats`, keyed by source name.
 *
 * Failure mode: all reads return safe defaults, all writes are try/catch.
 * If stats are unavailable, getSourceBias() returns the natural source
 * order — crawler degrades to its existing round-robin behavior.
 */

const { getStore } = require('@netlify/blobs');

const KNOWN_SOURCES = [
  'mcp-registry',
  'github-topics',
  'github-keywords',
  'npm',
  'smithery',
];

function sourceStatsStore() {
  return getStore('source-stats');
}

/**
 * Load the stats record for a single source. Returns a default shape if
 * the blob is missing or unparseable.
 */
async function loadStats(source) {
  try {
    const raw = await sourceStatsStore().get(source);
    if (!raw) return defaultStats(source);
    const parsed = JSON.parse(raw);
    return { ...defaultStats(source), ...parsed };
  } catch {
    return defaultStats(source);
  }
}

function defaultStats(source) {
  return {
    source,
    found: 0,
    scored: 0,
    scoredOver7: 0,
    scoredOver8: 0,
    totalComposite: 0,
    avgComposite: 0,
    lastUpdatedAt: null,
  };
}

/**
 * Record a single discovery outcome. Called by the nightly crawler after
 * each repo is scored, with the source tag and the full scoring result.
 *
 * Non-blocking: any failure silently no-ops so the crawler's scoring
 * loop is never interrupted.
 *
 * @param {string} source - One of KNOWN_SOURCES (or arbitrary string)
 * @param {string} repo - Lowercase owner/repo or npm:pkg
 * @param {object} result - The full scoring result from scoreAny()
 */
async function recordDiscovery(source, repo, result) {
  if (!source || !result) return;
  try {
    const stats = await loadStats(source);
    stats.found += 1;
    if (typeof result.composite === 'number' && !result.error) {
      stats.scored += 1;
      stats.totalComposite += result.composite;
      if (result.composite >= 7) stats.scoredOver7 += 1;
      if (result.composite >= 8) stats.scoredOver8 += 1;
      stats.avgComposite = stats.scored > 0
        ? +(stats.totalComposite / stats.scored).toFixed(3)
        : 0;
    }
    stats.lastUpdatedAt = new Date().toISOString();
    await sourceStatsStore().set(source, JSON.stringify(stats));
  } catch {
    // Silent — this is a decorator, never the critical path
  }
}

/**
 * Return the known sources sorted by their historical quality (descending
 * avgComposite). Sources with no data fall back to the KNOWN_SOURCES order.
 * The crawler reads this and processes its highest-yielding sources first.
 */
async function getSourceBias() {
  try {
    const records = await Promise.all(KNOWN_SOURCES.map(s => loadStats(s)));
    // Sort: sources with data (scored > 0) first, by avgComposite desc;
    // sources with no data last, preserving KNOWN_SOURCES order.
    const withData = records.filter(r => r.scored > 0);
    const withoutData = records.filter(r => r.scored === 0);
    withData.sort((a, b) => b.avgComposite - a.avgComposite);
    return [...withData.map(r => r.source), ...withoutData.map(r => r.source)];
  } catch {
    return [...KNOWN_SOURCES];
  }
}

/**
 * Return all source stats as a plain object. Used by the /trending page
 * and any future admin dashboard.
 */
async function loadAllStats() {
  try {
    const records = await Promise.all(KNOWN_SOURCES.map(s => loadStats(s)));
    const out = {};
    for (const r of records) out[r.source] = r;
    return out;
  } catch {
    return {};
  }
}

module.exports = {
  recordDiscovery,
  getSourceBias,
  loadStats,
  loadAllStats,
  KNOWN_SOURCES,
};
