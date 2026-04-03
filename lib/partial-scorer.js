/**
 * lib/partial-scorer.js — Fallback scoring for packages without a GitHub repo
 *
 * When the resolver can't find a source repo, we generate a limited trust score
 * using only npm registry metadata. This covers:
 *   - Publish history & recency
 *   - Download volume
 *   - Maintainer count
 *   - Dependency count
 *   - License presence
 *   - Package age
 *
 * The result is clearly labeled as "Limited" with fewer signals scored.
 * It should NOT be presented with the same confidence framing as full scores.
 */

function clamp(val, lo = 0.0, hi = 10.0) {
  return Math.max(lo, Math.min(hi, val));
}

function daysAgo(dateStr) {
  if (!dateStr) return 9999;
  try { return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24)); }
  catch { return 9999; }
}

// --- Partial Signals ---

function scorePublishRecency(lastPublish) {
  const days = daysAgo(lastPublish);
  if (days <= 30) return 9.5;
  if (days <= 90) return 7.5;
  if (days <= 180) return 5.5;
  if (days <= 365) return 3.5;
  return 1.0;
}

function scorePublishCadence(versionCount, created, lastPublish) {
  if (!versionCount || versionCount <= 1) return 2.0;
  const ageMonths = Math.max(1, daysAgo(created) / 30);
  const rate = versionCount / ageMonths; // versions per month

  if (rate >= 2.0) return 9.0;
  if (rate >= 1.0) return 7.5;
  if (rate >= 0.5) return 6.0;
  if (rate >= 0.2) return 4.5;
  return 2.5;
}

function scoreMaintainerCount(count) {
  if (count >= 5) return 9.0;
  if (count >= 3) return 7.5;
  if (count >= 2) return 5.5;
  if (count === 1) return 3.0;
  return 1.0;
}

function scorePackageAge(created) {
  const days = daysAgo(created);
  if (days >= 730) return 9.0;  // 2+ years
  if (days >= 365) return 7.0;
  if (days >= 180) return 5.0;
  if (days >= 90) return 3.5;
  return 2.0;
}

function scoreDependencyCount(depCount) {
  if (depCount === 0) return 9.0;
  if (depCount <= 3) return 8.0;
  if (depCount <= 10) return 7.0;
  if (depCount <= 25) return 5.0;
  if (depCount <= 50) return 3.5;
  return 2.0;
}

function scoreLicense(license) {
  if (!license) return 0.0;
  const permissive = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Unlicense', '0BSD', 'CC0-1.0'];
  const copyleft = ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0'];
  if (permissive.includes(license)) return 10.0;
  if (copyleft.includes(license)) return 6.0;
  return 4.0; // Unknown but present
}

async function fetchNpmDownloads(packageName) {
  try {
    const res = await fetch(
      `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(packageName)}`,
      { headers: { 'User-Agent': 'MCPSkills-Scorer/1.0' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.downloads ?? null;
  } catch { return null; }
}

function scoreDownloads(downloads) {
  if (downloads == null || downloads < 0) return 3.0;
  if (downloads >= 1000000) return 10.0;
  if (downloads >= 100000) return 9.0;
  if (downloads >= 10000) return 7.5;
  if (downloads >= 1000) return 6.0;
  if (downloads >= 100) return 4.0;
  if (downloads >= 10) return 2.5;
  return 1.0;
}

// --- Partial Signal Weights ---
const PARTIAL_WEIGHTS = {
  publish_recency: 0.20,
  publish_cadence: 0.10,
  download_adoption: 0.20,
  maintainer_count: 0.15,
  package_age: 0.10,
  dependency_count: 0.10,
  license_clarity: 0.15,
};

// Partial dimensions (subset of the full 4)
const PARTIAL_DIMENSIONS = {
  alive: ['publish_recency', 'publish_cadence'],
  legit: ['download_adoption', 'maintainer_count', 'package_age'],
  solid: ['dependency_count'],
  usable: ['license_clarity'],
};

// --- Main ---

/**
 * Generate a partial trust score from npm metadata.
 *
 * @param {string} packageName - npm package name
 * @param {object} npmMeta - metadata from resolver.resolveNpm()
 * @returns {object} - score result (clearly marked as limited)
 */
async function partialScore(packageName, npmMeta) {
  if (!npmMeta) {
    return {
      error: `No npm metadata available for "${packageName}". Cannot generate partial score.`,
    };
  }

  const downloads = await fetchNpmDownloads(packageName);

  const signals = {
    publish_recency: scorePublishRecency(npmMeta.lastPublish),
    publish_cadence: scorePublishCadence(npmMeta.versions, npmMeta.created, npmMeta.lastPublish),
    download_adoption: scoreDownloads(downloads),
    maintainer_count: scoreMaintainerCount(npmMeta.maintainerCount),
    package_age: scorePackageAge(npmMeta.created),
    dependency_count: scoreDependencyCount(npmMeta.dependencies),
    license_clarity: scoreLicense(npmMeta.license),
  };

  // Dimensions
  const dimensions = {};
  for (const [dim, signalNames] of Object.entries(PARTIAL_DIMENSIONS)) {
    const dimSignals = signalNames.filter(s => signals[s] != null);
    const dimWeightTotal = dimSignals.reduce((sum, s) => sum + PARTIAL_WEIGHTS[s], 0);
    if (dimWeightTotal === 0) { dimensions[dim] = 0; continue; }
    dimensions[dim] = dimSignals.reduce((sum, s) => sum + signals[s] * (PARTIAL_WEIGHTS[s] / dimWeightTotal), 0);
  }

  // Composite
  const totalWeight = Object.values(PARTIAL_WEIGHTS).reduce((a, b) => a + b, 0);
  const composite = Object.entries(signals).reduce(
    (sum, [s, val]) => sum + val * (PARTIAL_WEIGHTS[s] / totalWeight), 0
  );

  // Tier (more conservative for partial scores)
  let tier, tierReason;
  if (composite >= 7.0 && signals.download_adoption >= 6.0 && npmMeta.maintainerCount >= 2) {
    tier = 'established';
    tierReason = `Partial score ${composite.toFixed(1)} — limited to npm metadata only (no source code analysis)`;
  } else if (composite >= 4.5) {
    tier = 'new';
    tierReason = `Partial score ${composite.toFixed(1)} — limited data, no source code access`;
  } else {
    tier = 'new';
    tierReason = `Partial score ${composite.toFixed(1)} — insufficient data for higher tiers`;
  }

  return {
    repo: null,
    package: packageName,
    mode: 'partial',
    tier,
    tierReason,
    composite: Math.round(composite * 100) / 100,
    dimensions: Object.fromEntries(
      Object.entries(dimensions).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
    signals: Object.fromEntries(
      Object.entries(signals).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
    signalCount: Object.keys(signals).length,
    totalPossibleSignals: 14,
    disqualifiers: [],
    limited: true,
    limitedReason: 'No source repository found. Score based on npm registry metadata only. Safety scanning, code analysis, and supply chain checks could not be performed.',
    meta: {
      description: npmMeta.description || '',
      license: npmMeta.license || 'None',
      maintainers: npmMeta.maintainers || [],
      maintainerCount: npmMeta.maintainerCount || 0,
      versions: npmMeta.versions || 0,
      created: npmMeta.created,
      lastPublish: npmMeta.lastPublish,
      npmDownloads: downloads,
      homepage: npmMeta.homepage || null,
      keywords: npmMeta.keywords || [],
    },
    scannedAt: new Date().toISOString(),
  };
}

module.exports = { partialScore, PARTIAL_WEIGHTS, PARTIAL_DIMENSIONS };
