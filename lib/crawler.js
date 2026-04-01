/**
 * lib/crawler.js — Discover new repos from public registries and GitHub search.
 *
 * Sources:
 *   1. MCP Registry (registry.modelcontextprotocol.io) — official MCP servers
 *   2. GitHub topic search — mcp-server, openclaw repos
 *   3. GitHub code search — repos with SKILL.md
 *
 * Returns deduplicated list of owner/repo strings not already in the known set.
 */

async function ghApi(path, token) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'mcpskills-crawler' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Discover repos from the MCP Registry.
 * Returns array of "owner/repo" strings.
 */
async function discoverFromMcpRegistry() {
  const repos = [];
  try {
    const res = await fetch('https://registry.modelcontextprotocol.io/v0/servers');
    if (!res.ok) return repos;
    const data = await res.json();
    const servers = data.servers || [];

    for (const entry of servers) {
      const url = entry.server?.repository?.url || '';
      const match = url.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
      if (match) {
        repos.push(`${match[1]}/${match[2].replace(/\.git$/, '')}`);
      }
    }
  } catch (err) {
    console.warn('MCP Registry crawl failed:', err.message);
  }
  return repos;
}

/**
 * Discover repos from GitHub topic search.
 * Searches for recently-pushed repos with mcp-server or openclaw topics.
 * Returns array of "owner/repo" strings.
 */
async function discoverFromGitHubTopics(token, daysBack = 30) {
  const repos = [];
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const queries = [
    `topic:mcp-server+pushed:>${since}`,
    `topic:openclaw+pushed:>${since}`,
    `topic:mcp+pushed:>${since}+stars:>5`,
  ];

  for (const q of queries) {
    try {
      const data = await ghApi(`/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=50`, token);
      if (data?.items) {
        for (const item of data.items) {
          if (!item.archived && !item.fork) {
            repos.push(item.full_name);
          }
        }
      }
      // Rate limit: 10 search requests per minute for authenticated users
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`GitHub topic search failed for "${q}":`, err.message);
    }
  }

  return repos;
}

/**
 * Discover repos from GitHub keyword search.
 * Searches repo names/descriptions for MCP and skill keywords.
 * Returns array of "owner/repo" strings.
 */
async function discoverFromGitHubKeywords(token, daysBack = 14) {
  const repos = [];
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const queries = [
    `mcp-server+in:name+pushed:>${since}+stars:>2`,
    `"model context protocol"+in:description+pushed:>${since}`,
  ];

  for (const q of queries) {
    try {
      const data = await ghApi(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=30`, token);
      if (data?.items) {
        for (const item of data.items) {
          if (!item.archived && !item.fork) {
            repos.push(item.full_name);
          }
        }
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`GitHub keyword search failed for "${q}":`, err.message);
    }
  }

  return repos;
}

/**
 * Run all discovery sources and return deduplicated new repos.
 *
 * @param {Set<string>} knownRepos — repos already in cache (lowercase)
 * @param {string} token — GitHub token
 * @param {number} maxNew — cap on how many new repos to return
 * @returns {string[]} — new repos to score
 */
async function discoverNewRepos(knownRepos, token, maxNew = 30) {
  console.log('Starting discovery crawl...');

  const [registryRepos, topicRepos, keywordRepos] = await Promise.all([
    discoverFromMcpRegistry(),
    discoverFromGitHubTopics(token, 30),
    discoverFromGitHubKeywords(token, 14),
  ]);

  console.log(`Discovery results: registry=${registryRepos.length}, topics=${topicRepos.length}, keywords=${keywordRepos.length}`);

  // Deduplicate and filter out known repos
  const allRepos = [...registryRepos, ...topicRepos, ...keywordRepos];
  const seen = new Set();
  const newRepos = [];

  for (const repo of allRepos) {
    const lower = repo.toLowerCase();
    if (seen.has(lower) || knownRepos.has(lower)) continue;
    seen.add(lower);
    newRepos.push(repo);
  }

  console.log(`Found ${newRepos.length} new repos (${seen.size} unique total, ${knownRepos.size} already known)`);

  return newRepos.slice(0, maxNew);
}

module.exports = {
  discoverNewRepos,
  discoverFromMcpRegistry,
  discoverFromGitHubTopics,
  discoverFromGitHubKeywords,
};
