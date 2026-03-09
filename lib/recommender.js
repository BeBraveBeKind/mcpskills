/**
 * MCP Skills — Recommendation Engine
 *
 * When a user scans a repo, suggest alternatives that:
 * 1. Are in the same category
 * 2. Have higher (or comparable) trust scores
 * 3. Offer different strengths
 *
 * Also surfaces "you scanned X, you might also need Y" cross-category suggestions.
 */

const path = require('path');
const fs = require('fs');

let registryCache = null;
let scoreCacheData = null;

// Resolve data dir — works both locally and in Netlify Functions.
// In Netlify esbuild bundles, __dirname varies based on which function imports us.
// We search multiple candidate paths to find where data/ actually lives.
let _dataDir = null;
function dataDir() {
  if (_dataDir) return _dataDir;
  const candidates = [
    path.join(__dirname, '..', 'data'),                 // local: lib/ -> data/
    path.join(__dirname, '..', '..', 'data'),           // Netlify: bundled in netlify/functions/ -> ../../data
    path.join(__dirname, '..', '..', '..', 'data'),     // deeper nesting
    '/var/task/data',                                    // Netlify included_files absolute
    path.join(process.cwd(), 'data'),                    // cwd fallback
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'registry.json'))) {
        _dataDir = dir;
        return dir;
      }
    } catch {}
  }
  _dataDir = candidates[0];
  return _dataDir;
}

function loadRegistry() {
  if (registryCache) return registryCache;
  const registryPath = path.join(dataDir(), 'registry.json');
  registryCache = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  return registryCache;
}

function loadScoreCache() {
  if (scoreCacheData) return scoreCacheData;
  const cachePath = path.join(dataDir(), 'score-cache.json');
  try {
    scoreCacheData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    scoreCacheData = {};
  }
  return scoreCacheData;
}

function saveScoreCache(cache) {
  try {
    const cachePath = path.join(dataDir(), 'score-cache.json');
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // In serverless environments, file writes may fail — that's OK, use in-memory cache
  }
  scoreCacheData = cache;
}

/**
 * Find which categories a repo belongs to.
 * Uses: exact match in registry, keyword matching on repo metadata.
 */
function categorizeRepo(owner, repo, repoData) {
  const registry = loadRegistry();
  const categories = [];

  const repoKey = `${owner}/${repo}`.toLowerCase();
  const description = (repoData?.description || '').toLowerCase();
  const name = repo.toLowerCase();
  const topics = (repoData?.topics || []).map(t => t.toLowerCase());
  const searchText = `${name} ${description} ${topics.join(' ')}`;

  for (const [catId, cat] of Object.entries(registry.categories)) {
    // Exact match in registry
    const isListed = cat.repos.some(r =>
      r.owner.toLowerCase() === owner.toLowerCase() &&
      r.repo.toLowerCase() === repo.toLowerCase()
    );
    if (isListed) {
      categories.push({ id: catId, name: cat.name, confidence: 'exact' });
      continue;
    }

    // Keyword match
    const matchCount = cat.keywords.filter(kw => searchText.includes(kw)).length;
    if (matchCount >= 2) {
      categories.push({ id: catId, name: cat.name, confidence: 'keyword', matchCount });
    }
  }

  return categories;
}

/**
 * Get alternative repos in the same category, excluding the scanned repo.
 * Returns cached scores where available, otherwise returns registry metadata.
 */
function getAlternatives(owner, repo, categories, limit = 3) {
  const registry = loadRegistry();
  const cache = loadScoreCache();
  const repoKey = `${owner}/${repo}`.toLowerCase();
  const alternatives = [];

  for (const cat of categories) {
    const catData = registry.categories[cat.id];
    if (!catData) continue;

    const altRepos = catData.repos
      .filter(r => `${r.owner}/${r.repo}`.toLowerCase() !== repoKey)
      .map(r => {
        const key = `${r.owner}/${r.repo}`;
        const cached = cache[key];
        return {
          repo: key,
          label: r.label,
          category: cat.name,
          score: cached?.composite ?? null,
          tier: cached?.tier ?? null,
          stars: cached?.meta?.stars ?? null,
          npmDownloads: cached?.meta?.npmDownloads ?? null,
          lastScanned: cached?.scannedAt ?? null,
        };
      });

    // Sort: scored repos first (by score desc), then unscored
    altRepos.sort((a, b) => {
      if (a.score !== null && b.score !== null) return b.score - a.score;
      if (a.score !== null) return -1;
      if (b.score !== null) return 1;
      return 0;
    });

    alternatives.push(...altRepos.slice(0, limit));
  }

  // Dedupe (a repo could appear in multiple categories)
  const seen = new Set();
  return alternatives.filter(a => {
    if (seen.has(a.repo)) return false;
    seen.add(a.repo);
    return true;
  }).slice(0, limit);
}

/**
 * Get cross-category suggestions ("you scanned an AI SDK, you might also need...")
 */
const CROSS_CATEGORY_MAP = {
  'ai-sdk': ['mcp-server', 'testing', 'validation'],
  'mcp-server': ['ai-sdk', 'auth', 'database'],
  'database': ['auth', 'validation', 'web-framework'],
  'auth': ['database', 'payments', 'web-framework'],
  'payments': ['auth', 'email', 'web-framework'],
  'ui': ['web-framework', 'testing', 'validation'],
  'email': ['payments', 'auth'],
  'testing': ['devops', 'ai-sdk'],
  'devops': ['testing', 'database'],
  'web-framework': ['database', 'auth', 'ui'],
  'validation': ['database', 'ai-sdk'],
};

function getCrossCategorySuggestions(categories, limit = 2) {
  const registry = loadRegistry();
  const cache = loadScoreCache();
  const suggestions = [];
  const seenCats = new Set(categories.map(c => c.id));

  for (const cat of categories) {
    const related = CROSS_CATEGORY_MAP[cat.id] || [];
    for (const relatedCatId of related) {
      if (seenCats.has(relatedCatId)) continue;
      seenCats.add(relatedCatId);

      const catData = registry.categories[relatedCatId];
      if (!catData) continue;

      // Pick the top-scored repo from this category
      const topRepo = catData.repos
        .map(r => {
          const key = `${r.owner}/${r.repo}`;
          const cached = cache[key];
          return { ...r, repo: key, score: cached?.composite ?? null, tier: cached?.tier ?? null };
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        [0];

      if (topRepo) {
        suggestions.push({
          category: catData.name,
          repo: topRepo.repo,
          label: topRepo.label,
          score: topRepo.score,
          tier: topRepo.tier,
          reason: `Commonly used alongside ${cat.name}`,
        });
      }
    }
  }

  return suggestions.slice(0, limit);
}

/**
 * Cache a score result for future recommendations.
 */
function cacheScore(result) {
  if (!result || result.error) return;
  const cache = loadScoreCache();
  cache[result.repo] = {
    composite: result.composite,
    tier: result.tier,
    mode: result.mode,
    meta: result.meta,
    scannedAt: result.scannedAt,
  };
  saveScoreCache(cache);
}

/**
 * Build full recommendation response for a scored repo.
 */
function recommend(owner, repo, scoreResult) {
  // Cache the score we just computed
  cacheScore(scoreResult);

  const categories = categorizeRepo(owner, repo, {
    description: scoreResult?.meta?.description,
    topics: [], // topics aren't in the score result yet, but category keywords cover it
  });

  if (categories.length === 0) {
    return {
      categories: [],
      alternatives: [],
      crossCategory: [],
      message: null,
    };
  }

  const alternatives = getAlternatives(owner, repo, categories, 3);
  const crossCategory = getCrossCategorySuggestions(categories, 2);

  // Build recommendation message
  let message = null;
  if (alternatives.length > 0) {
    const scored = alternatives.filter(a => a.score !== null);
    const higher = scored.filter(a => a.score > (scoreResult?.composite || 0));

    if (higher.length > 0) {
      message = `${higher.length} alternative(s) with higher trust scores in ${categories[0].name}`;
    } else if (scored.length > 0) {
      message = `${scored.length} comparable alternative(s) in ${categories[0].name}`;
    } else {
      message = `${alternatives.length} alternative(s) in ${categories[0].name} (not yet scored)`;
    }
  }

  return {
    categories: categories.map(c => ({ id: c.id, name: c.name })),
    alternatives,
    crossCategory,
    message,
  };
}

module.exports = {
  recommend,
  categorizeRepo,
  getAlternatives,
  getCrossCategorySuggestions,
  cacheScore,
  loadScoreCache,
};
