/**
 * MCP Skills Trust Scoring Engine
 * 12 signals across 4 dimensions → 3 trust tiers
 * Standard Mode (10 signals) for generic repos
 * Skills Mode (12 signals) for MCP servers and agent skills
 */

const { detectSkill, scoreSkillSpecCompliance, scoreToolSafety, fetchScanTargets, parseSkillMdFrontmatter, scoreSecurityTransparency } = require('./skills');

// Standard Mode weights (generic repos)
const WEIGHTS = {
  commit_recency: 0.10,
  release_cadence: 0.08,
  issue_responsiveness: 0.07,
  author_credibility: 0.12,
  community_adoption: 0.10,
  contributor_diversity: 0.08,  // Signal: bus factor / single-author risk
  security_posture: 0.13,
  dependency_health: 0.10,
  readme_quality: 0.07,
  file_structure: 0.07,
  license_clarity: 0.05,
  download_adoption: 0.03,     // npm downloads (if available)
};

// Skills Mode weights (MCP servers, agent skills)
const SKILLS_WEIGHTS = {
  commit_recency: 0.08,
  release_cadence: 0.06,
  issue_responsiveness: 0.06,
  author_credibility: 0.10,
  community_adoption: 0.07,
  contributor_diversity: 0.07,
  security_posture: 0.10,
  dependency_health: 0.08,
  readme_quality: 0.04,
  skill_spec_compliance: 0.08,
  license_clarity: 0.04,
  tool_safety: 0.14,           // Highest weight — safety is paramount for skills
  download_adoption: 0.03,
  supply_chain_safety: 0.05,   // GitHub Actions / CI pipeline safety
};

const DIMENSIONS = {
  alive: ['commit_recency', 'release_cadence', 'issue_responsiveness'],
  legit: ['author_credibility', 'community_adoption', 'contributor_diversity', 'download_adoption'],
  solid: ['security_posture', 'dependency_health'],
  usable: ['readme_quality', 'file_structure', 'license_clarity'],
};

const SKILLS_DIMENSIONS = {
  alive: ['commit_recency', 'release_cadence', 'issue_responsiveness'],
  legit: ['author_credibility', 'community_adoption', 'contributor_diversity', 'download_adoption'],
  solid: ['security_posture', 'dependency_health', 'tool_safety', 'supply_chain_safety'],
  usable: ['readme_quality', 'skill_spec_compliance', 'license_clarity'],
};

const LICENSE_SCORES = {
  'MIT': 10, 'mit': 10, 'MIT License': 10,
  'Apache-2.0': 10, 'apache-2.0': 10, 'Apache License 2.0': 10,
  'BSD-2-Clause': 10, 'bsd-2-clause': 10,
  'BSD-3-Clause': 10, 'bsd-3-clause': 10,
  'ISC': 10, 'isc': 10,
  'Unlicense': 10, 'unlicense': 10,
  '0BSD': 10,
  'MPL-2.0': 8, 'mpl-2.0': 8,
  'LGPL-2.1': 8, 'lgpl-2.1': 8,
  'LGPL-3.0': 8, 'lgpl-3.0': 8,
  'GPL-2.0': 5, 'gpl-2.0': 5,
  'GPL-3.0': 5, 'gpl-3.0': 5,
  'AGPL-3.0': 3, 'agpl-3.0': 3,
  'CC0-1.0': 10, 'CC-BY-4.0': 8,
  'BSL-1.0': 6, 'WTFPL': 10,
};

// --- Helpers ---

function clamp(val, lo = 0.0, hi = 10.0) {
  return Math.max(lo, Math.min(hi, val));
}

function daysAgo(dateStr) {
  if (!dateStr) return 9999;
  try {
    const dt = new Date(dateStr);
    return Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return 9999;
  }
}

async function ghApi(path, token) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'MCPSkills-Scorer/1.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function scorecardApi(owner, repo) {
  try {
    const res = await fetch(
      `https://api.scorecard.dev/projects/github.com/${owner}/${repo}`,
      { headers: { 'User-Agent': 'MCPSkills-Scorer/1.0' } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- Signal Scorers ---

function scoreCommitRecency(repoData) {
  const pushed = daysAgo(repoData.pushed_at);
  let score;
  if (pushed <= 14) score = 9.5;
  else if (pushed <= 30) score = 7.5;
  else if (pushed <= 90) score = 5.5;
  else if (pushed <= 180) score = 3.5;
  else if (pushed <= 365) score = 1.5;
  else score = 0;
  return clamp(score);
}

function scoreReleaseCadence(releases) {
  if (!releases || releases.length === 0) return 1.0;

  const recent6mo = releases.filter(r => daysAgo(r.published_at || r.created_at) <= 180);
  const recent12mo = releases.filter(r => daysAgo(r.published_at || r.created_at) <= 365);
  const latestDays = daysAgo(releases[0]?.published_at || releases[0]?.created_at);

  if (recent6mo.length >= 3 && latestDays <= 60) return 9.5;
  if (recent6mo.length >= 2) return 7.5;
  if (recent6mo.length >= 1) return 5.5;
  if (recent12mo.length >= 1) return 3.5;
  if (latestDays <= 730) return 1.5;
  return 0.5;
}

function scoreIssueResponsiveness(issues) {
  if (!issues || issues.length < 5) return 5.0;

  const total = issues.length;
  const closed = issues.filter(i => i.state === 'closed').length;
  const closeRate = total > 0 ? closed / total : 0;

  const recentClosed = issues.filter(
    i => i.state === 'closed' && daysAgo(i.closed_at) <= 90
  ).length;
  const recentUpdated = issues.filter(
    i => daysAgo(i.updated_at) <= 30
  ).length;

  // 70% recent activity, 30% overall close rate
  let recentScore;
  if (recentClosed >= 5) recentScore = 9.0;
  else if (recentClosed >= 3) recentScore = 7.5;
  else if (recentClosed >= 1) recentScore = 6.0;
  else if (recentUpdated >= 5) recentScore = 5.0;
  else recentScore = 2.0;

  let overallScore;
  if (closeRate >= 0.7) overallScore = 9.0;
  else if (closeRate >= 0.5) overallScore = 7.0;
  else if (closeRate >= 0.3) overallScore = 5.0;
  else if (closeRate >= 0.1) overallScore = 3.0;
  else overallScore = 1.0;

  return clamp(recentScore * 0.7 + overallScore * 0.3);
}

function scoreAuthorCredibility(ownerData, ownerRepos) {
  if (!ownerData) return 2.0;

  const isOrg = ownerData.type === 'Organization';
  const followers = ownerData.followers || 0;
  const highStarRepos = ownerRepos
    ? ownerRepos.filter(r => (r.stargazers_count || 0) >= 100).length
    : 0;
  const created = daysAgo(ownerData.created_at);

  let score = 3.0;
  if (isOrg) {
    score += 1.0;
    if (ownerData.is_verified) score += 2.0;
  }
  if (followers >= 1000) score += 2.0;
  else if (followers >= 100) score += 1.0;
  else if (followers >= 10) score += 0.5;

  if (highStarRepos >= 5) score += 2.0;
  else if (highStarRepos >= 2) score += 1.0;

  if (created >= 730) score += 1.0;
  else if (created >= 365) score += 0.5;

  return clamp(score);
}

function scoreCommunityAdoption(repoData) {
  const stars = repoData.stargazers_count || 0;
  const forks = repoData.forks_count || 0;

  let score;
  if (stars >= 5000 && forks >= 500) score = 9.5;
  else if (stars >= 1000 && forks >= 100) score = 7.5;
  else if (stars >= 200 && forks >= 20) score = 5.5;
  else if (stars >= 50 && forks >= 5) score = 3.5;
  else if (stars >= 10) score = 1.5;
  else score = 0.5;

  // Star-to-fork ratio gaming detection
  if (stars > 100 && forks > 0 && stars / forks > 100) {
    score = Math.min(score, 6.0);
  }
  return clamp(score);
}

function scoreSecurityPosture(scorecardData, treeData) {
  if (scorecardData) {
    const agg = scorecardData.score ?? scorecardData.aggregate_score;
    if (agg != null) return clamp(agg);

    const checks = scorecardData.checks || [];
    const validScores = checks.filter(c => c.score >= 0).map(c => c.score);
    if (validScores.length > 0) {
      return clamp(validScores.reduce((a, b) => a + b, 0) / validScores.length);
    }
  }

  // Heuristic fallback
  if (!treeData) return 3.0;

  const files = (treeData.tree || []).map(f => (f.path || '').toLowerCase());
  let score = 3.0;

  if (files.some(f => f.includes('.github/workflows'))) score += 1.5;
  if (files.some(f => f.includes('security') && f.endsWith('.md'))) score += 1.5;
  if (files.some(f => f.includes('codeql'))) score += 1.0;
  if (files.some(f => f.includes('codeowners'))) score += 0.5;

  return clamp(score);
}

function scoreDependencyHealth(treeData) {
  if (!treeData) return 5.0;

  const files = (treeData.tree || []).map(f => f.path || '');
  let score = 5.0;

  const hasDependabot = files.some(f => f.toLowerCase().includes('dependabot'));
  const hasRenovate = files.some(f => f.toLowerCase().includes('renovate'));
  if (hasDependabot || hasRenovate) score += 2.0;

  const hasLock = files.some(f =>
    ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
     'Pipfile.lock', 'poetry.lock', 'go.sum', 'Cargo.lock'].includes(f)
  );
  if (hasLock) score += 1.0;

  const hasSecScan = files.some(f =>
    f.toLowerCase().includes('codeql') || f.toLowerCase().includes('snyk')
  );
  if (hasSecScan) score += 1.0;

  const hasManifest = files.some(f =>
    ['package.json', 'requirements.txt', 'pyproject.toml',
     'go.mod', 'Cargo.toml', 'Gemfile'].includes(f)
  );
  if (!hasManifest) score = 8.0;

  return clamp(score);
}

function scoreReadmeQuality(readmeContent, treeData) {
  if (!readmeContent || readmeContent.length < 100) {
    return readmeContent ? 1.0 : 0.0;
  }

  let score = 2.0;
  const lower = readmeContent.toLowerCase();

  if (readmeContent.length >= 2000) score += 1.5;
  else if (readmeContent.length >= 500) score += 1.0;

  if ((readmeContent.match(/#/g) || []).length >= 3) score += 1.0;
  if (readmeContent.includes('```')) score += 1.5;
  if (lower.includes('install') || lower.includes('getting started')) score += 1.0;
  if (lower.includes('usage') || lower.includes('example')) score += 1.0;
  if (lower.includes('license')) score += 0.5;
  if (readmeContent.includes('[![') || readmeContent.includes('![')) score += 0.5;

  // Docs-site projects
  const docsPatterns = [
    /https?:\/\/[\w.-]+\.dev/,
    /https?:\/\/docs\./,
    /https?:\/\/[\w.-]+\/docs/,
    /documentation/,
    /full docs/,
    /read the docs/,
  ];
  if (docsPatterns.some(p => p.test(lower))) score += 1.5;

  if (treeData) {
    const dirs = (treeData.tree || [])
      .filter(f => f.type === 'tree')
      .map(f => f.path || '');
    if (dirs.some(d => ['docs', 'doc', 'documentation'].includes(d))) score += 1.0;
  }

  return clamp(score);
}

function scoreFileStructure(treeData) {
  if (!treeData) return 3.0;

  const files = (treeData.tree || []).map(f => f.path || '');
  const topLevel = files.filter(f => !f.includes('/'));
  const topDirs = (treeData.tree || [])
    .filter(f => f.type === 'tree' && !f.path.includes('/'))
    .map(f => f.path);

  const checks = {
    srcDir: topDirs.some(d => ['src', 'lib', 'pkg', 'packages'].includes(d)),
    testDir: topDirs.some(d => ['test', 'tests', '__tests__', 'spec'].includes(d)),
    docsDir: topDirs.some(d => ['docs', 'doc', 'documentation'].includes(d)),
    gitignore: topLevel.includes('.gitignore'),
    ciConfig: files.some(f => f.includes('workflow') || f.includes('.github')),
    configFiles: topLevel.some(f =>
      ['tsconfig.json', 'eslint.config.js', '.eslintrc', '.prettierrc',
       'setup.py', 'pyproject.toml', 'prettier.config.js'].includes(f)
    ),
    changelog: topLevel.some(f => f.toLowerCase().startsWith('changelog')),
    contributing: topLevel.some(f => f.toLowerCase().startsWith('contributing')),
  };

  const met = Object.values(checks).filter(Boolean).length;
  return clamp(2.0 + met * 1.0);
}

function scoreContributorDiversity(contributors) {
  if (!contributors || !Array.isArray(contributors)) return 3.0;

  const count = contributors.length;
  const totalCommits = contributors.reduce((sum, c) => sum + (c.contributions || 0), 0);

  // Single author = bus factor risk
  if (count <= 1) return 1.5;
  if (count === 2) return 3.5;

  // Check commit concentration — if top contributor has >90% of commits, it's effectively single-author
  const topContrib = contributors[0]?.contributions || 0;
  const concentration = totalCommits > 0 ? topContrib / totalCommits : 1;

  let score;
  if (count >= 20 && concentration < 0.5) score = 9.5;
  else if (count >= 10 && concentration < 0.6) score = 8.0;
  else if (count >= 5 && concentration < 0.7) score = 6.5;
  else if (count >= 3) score = 5.0;
  else score = 3.0;

  // Penalize high concentration even with many contributors
  if (concentration > 0.9) score = Math.min(score, 3.0);
  else if (concentration > 0.8) score = Math.min(score, 5.0);

  return clamp(score);
}

function scoreDownloadAdoption(npmDownloads) {
  if (npmDownloads == null || npmDownloads < 0) return 5.0; // neutral if no npm package

  if (npmDownloads >= 1000000) return 10.0;
  if (npmDownloads >= 100000) return 9.0;
  if (npmDownloads >= 10000) return 7.5;
  if (npmDownloads >= 1000) return 6.0;
  if (npmDownloads >= 100) return 4.0;
  if (npmDownloads >= 10) return 2.5;
  return 1.0;
}

function scoreDependencyCount(packageJsonContent) {
  if (!packageJsonContent) return 5.0; // neutral

  try {
    const pj = JSON.parse(packageJsonContent);
    const deps = Object.keys(pj.dependencies || {}).length;

    // Fewer production deps = smaller attack surface
    let score = 7.0;
    if (deps === 0) score = 9.0;      // zero-dep is excellent
    else if (deps <= 3) score = 8.0;
    else if (deps <= 10) score = 7.0;
    else if (deps <= 25) score = 5.5;
    else if (deps <= 50) score = 4.0;
    else score = 2.5;                  // 50+ deps = significant attack surface

    return clamp(score);
  } catch {
    return 5.0;
  }
}

function scoreSupplyChainSafety(workflowContents) {
  if (!workflowContents || Object.keys(workflowContents).length === 0) return { score: 6.0, findings: [] }; // no CI = neutral-low

  const BASELINE = 8.0;
  let penalty = 0;
  const findings = [];

  for (const [filename, content] of Object.entries(workflowContents)) {
    // Check for unpinned actions (uses: owner/action@main instead of @sha)
    const unpinnedActions = content.match(/uses:\s+[\w-]+\/[\w-]+@(?:main|master|latest|v\d+)\b/g);
    if (unpinnedActions) {
      penalty += 0.5 * Math.min(unpinnedActions.length, 4); // cap at 2.0
      findings.push({ file: filename, issue: 'unpinned_actions', count: unpinnedActions.length });
    }

    // Check for GITHUB_TOKEN sent to external URLs
    const tokenExfil = /\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}[\s\S]{0,200}(?:curl|wget|fetch|http)/i.test(content);
    if (tokenExfil) {
      penalty += 2.0;
      findings.push({ file: filename, issue: 'token_exfiltration_risk' });
    }

    // Check for pull_request_target with checkout (known attack vector)
    if (/pull_request_target/i.test(content) && /actions\/checkout/i.test(content)) {
      const checksoutPR = /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(sha|ref)/i.test(content);
      if (checksoutPR) {
        penalty += 2.5;
        findings.push({ file: filename, issue: 'pull_request_target_checkout' });
      }
    }

    // Check for script injection via issue/PR titles/bodies
    const scriptInjection = /\$\{\{\s*github\.event\.(issue|pull_request|comment)\.(title|body|comment\.body)/i.test(content);
    if (scriptInjection) {
      penalty += 1.5;
      findings.push({ file: filename, issue: 'workflow_script_injection' });
    }

    // Check for self-hosted runners (potential lateral movement)
    if (/runs-on:\s*self-hosted/i.test(content)) {
      penalty += 0.5;
      findings.push({ file: filename, issue: 'self_hosted_runner' });
    }
  }

  return { score: clamp(BASELINE - penalty), findings };
}

function scoreLicenseClarity(repoData) {
  const license = repoData.license;
  if (!license) return 0.0;

  const spdx = license.spdx_id || '';
  const name = license.name || '';

  for (const key of [spdx, name]) {
    if (LICENSE_SCORES[key] != null) return LICENSE_SCORES[key];
  }

  if (spdx && spdx !== 'NOASSERTION') return 4.0;
  return 1.0;
}

// --- Main Scoring Function ---

async function fetchNpmDownloads(packageJsonContent) {
  if (!packageJsonContent) return null;
  try {
    const pj = JSON.parse(packageJsonContent);
    const name = pj.name;
    if (!name) return null;
    const res = await fetch(
      `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`,
      { headers: { 'User-Agent': 'MCPSkills-Scorer/1.0' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.downloads ?? null;
  } catch {
    return null;
  }
}

async function fetchWorkflowContents(owner, repo, treeData, token) {
  if (!treeData) return {};
  const files = (treeData.tree || []).map(f => f.path || '');
  const workflows = files.filter(f =>
    f.startsWith('.github/workflows/') && (f.endsWith('.yml') || f.endsWith('.yaml'))
  ).slice(0, 10);

  if (workflows.length === 0) return {};

  const results = await Promise.all(
    workflows.map(async (filepath) => {
      const data = await ghApi(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filepath)}`, token);
      if (!data?.content) return [filepath, null];
      try {
        return [filepath, Buffer.from(data.content, 'base64').toString('utf-8')];
      } catch { return [filepath, null]; }
    })
  );

  return Object.fromEntries(results.filter(([, content]) => content !== null));
}

async function scoreRepo(owner, repo, token) {
  // Wave 1: Fetch core data in parallel
  const [repoData, releases, issues, scorecardData] = await Promise.all([
    ghApi(`/repos/${owner}/${repo}`, token),
    ghApi(`/repos/${owner}/${repo}/releases?per_page=30`, token),
    ghApi(`/repos/${owner}/${repo}/issues?state=all&per_page=30&sort=updated`, token),
    scorecardApi(owner, repo),
  ]);

  if (!repoData) {
    return { error: `Could not fetch repo data for ${owner}/${repo}` };
  }

  // Wave 2: Owner + tree + README + contributors
  const ownerType = repoData.owner?.type;
  const defaultBranch = repoData.default_branch || 'main';

  const [ownerData, ownerRepos, treeData, readmeData, contributors] = await Promise.all([
    ownerType === 'Organization'
      ? ghApi(`/orgs/${owner}`, token)
      : ghApi(`/users/${owner}`, token),
    ghApi(`/users/${owner}/repos?sort=stars&per_page=10`, token),
    ghApi(`/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, token),
    ghApi(`/repos/${owner}/${repo}/readme`, token),
    ghApi(`/repos/${owner}/${repo}/contributors?per_page=30`, token),
  ]);

  // Decode README
  let readmeContent = '';
  if (readmeData?.content) {
    try {
      readmeContent = Buffer.from(readmeData.content, 'base64').toString('utf-8');
    } catch {}
  }

  // --- Fetch package.json + npm downloads in parallel ---
  let packageJsonContent = null;
  if (treeData) {
    const pjFile = (treeData.tree || []).find(f => f.path === 'package.json');
    if (pjFile) {
      const pjData = await ghApi(`/repos/${owner}/${repo}/contents/package.json`, token);
      if (pjData?.content) {
        try { packageJsonContent = Buffer.from(pjData.content, 'base64').toString('utf-8'); } catch {}
      }
    }
  }

  // Fetch npm downloads (non-blocking — returns null if no npm package)
  const npmDownloads = await fetchNpmDownloads(packageJsonContent);

  // --- Skill Detection ---
  const skillInfo = detectSkill(treeData, packageJsonContent, repoData);
  const isSkillsMode = skillInfo.isSkill;

  // --- Compute base signals (always) ---
  const depCountScore = scoreDependencyCount(packageJsonContent);
  const baseDependencyHealth = scoreDependencyHealth(treeData);
  // Blend file-based dependency health with actual dep count analysis
  const blendedDependencyHealth = clamp(baseDependencyHealth * 0.5 + depCountScore * 0.5);

  const signals = {
    commit_recency: scoreCommitRecency(repoData),
    release_cadence: scoreReleaseCadence(releases || []),
    issue_responsiveness: scoreIssueResponsiveness(issues || []),
    author_credibility: scoreAuthorCredibility(ownerData, ownerRepos || []),
    community_adoption: scoreCommunityAdoption(repoData),
    contributor_diversity: scoreContributorDiversity(contributors || []),
    security_posture: scoreSecurityPosture(scorecardData, treeData),
    dependency_health: blendedDependencyHealth,
    readme_quality: scoreReadmeQuality(readmeContent, treeData),
    license_clarity: scoreLicenseClarity(repoData),
    download_adoption: scoreDownloadAdoption(npmDownloads),
  };

  // --- Skills Mode: add skill-specific signals ---
  let safetyResult = null;
  let specResult = null;
  let supplyChainResult = null;
  let frontmatter = null;
  let transparencyResult = null;

  if (isSkillsMode) {
    // Signal: Skill Spec Compliance
    let skillMdContent = null;
    let serverJsonContent = null;

    const skillMdFile = (treeData?.tree || []).find(f =>
      f.path.toLowerCase() === 'skill.md'
    );
    if (skillMdFile) {
      const data = await ghApi(`/repos/${owner}/${repo}/contents/SKILL.md`, token);
      if (data?.content) {
        try { skillMdContent = Buffer.from(data.content, 'base64').toString('utf-8'); } catch {}
      }
    }

    const serverJsonFile = (treeData?.tree || []).find(f =>
      f.path.toLowerCase() === 'server.json' || f.path.toLowerCase() === 'mcp.json'
    );
    if (serverJsonFile) {
      const data = await ghApi(`/repos/${owner}/${repo}/contents/${serverJsonFile.path}`, token);
      if (data?.content) {
        try { serverJsonContent = Buffer.from(data.content, 'base64').toString('utf-8'); } catch {}
      }
    }

    specResult = scoreSkillSpecCompliance(treeData, skillMdContent, serverJsonContent, packageJsonContent);
    signals.skill_spec_compliance = specResult.score;

    // Signal: Tool Safety Analysis + Supply Chain Safety (fetch in parallel)
    const [scanTargets, workflowContents] = await Promise.all([
      fetchScanTargets(owner, repo, treeData, token),
      fetchWorkflowContents(owner, repo, treeData, token),
    ]);

    safetyResult = scoreToolSafety(scanTargets.fileContents, scanTargets.markdownContents);
    signals.tool_safety = safetyResult.score;

    // YAML frontmatter transparency bonus (OpenClaw integration)
    if (skillMdContent) {
      frontmatter = parseSkillMdFrontmatter(skillMdContent);
      if (frontmatter) {
        transparencyResult = scoreSecurityTransparency(frontmatter);
        // Apply bonus to tool_safety (capped at 10)
        signals.tool_safety = Math.min(10, signals.tool_safety + transparencyResult.bonus);
      }
    }

    supplyChainResult = scoreSupplyChainSafety(workflowContents);
    signals.supply_chain_safety = supplyChainResult.score;
  } else {
    // Standard Mode: use file_structure
    signals.file_structure = scoreFileStructure(treeData);
  }

  // --- Select weight system ---
  const activeWeights = isSkillsMode ? SKILLS_WEIGHTS : WEIGHTS;
  const activeDimensions = isSkillsMode ? SKILLS_DIMENSIONS : DIMENSIONS;

  // Dimension scores (only count signals that exist, have weights, and are valid numbers)
  const dimensions = {};
  for (const [dim, signalNames] of Object.entries(activeDimensions)) {
    const dimWeights = Object.fromEntries(
      signalNames.filter(s => signals[s] != null && !isNaN(signals[s]) && activeWeights[s] !== undefined)
        .map(s => [s, activeWeights[s]])
    );
    const totalDimWeight = Object.values(dimWeights).reduce((a, b) => a + b, 0);
    if (totalDimWeight === 0) { dimensions[dim] = 0; continue; }
    dimensions[dim] = Object.entries(dimWeights).reduce(
      (sum, [s, w]) => sum + signals[s] * (w / totalDimWeight), 0
    );
  }

  // Composite score (guard against null/undefined/NaN signals)
  const activeSignals = Object.entries(signals)
    .filter(([s, val]) => activeWeights[s] !== undefined && val != null && !isNaN(val));
  const totalWeight = activeSignals.reduce((sum, [s]) => sum + activeWeights[s], 0);
  const composite = totalWeight > 0
    ? activeSignals.reduce((sum, [s, val]) => sum + val * (activeWeights[s] / totalWeight), 0)
    : 0;

  // Disqualifiers
  const disqualifiers = [];
  const archived = repoData.archived || false;
  if (archived) disqualifiers.push('ARCHIVED');
  if (signals.license_clarity === 0) disqualifiers.push('NO_LICENSE');
  if (signals.security_posture <= 2.0 && !scorecardData) disqualifiers.push('NO_SCORECARD');
  if (isSkillsMode && safetyResult?.isBlocked) disqualifiers.push('SAFETY_BLOCK');
  if (isSkillsMode && supplyChainResult?.score <= 2.0 &&
      supplyChainResult?.findings?.some(f => f.issue === 'token_exfiltration_risk' || f.issue === 'pull_request_target_checkout')) {
    disqualifiers.push('SUPPLY_CHAIN_RISK');
  }
  if (signals.contributor_diversity <= 1.5 && (repoData.stargazers_count || 0) < 10) {
    disqualifiers.push('SINGLE_AUTHOR_LOW_ADOPTION');
  }

  // Tier assignment
  const sufficientSignals = Object.values(signals).filter(s => s > 0).length;
  let tier, tierReason;

  if (disqualifiers.includes('SAFETY_BLOCK')) {
    tier = 'blocked';
    tierReason = 'Safety concern detected — blocked from all tiers';
  } else if (disqualifiers.includes('ARCHIVED')) {
    tier = 'new';
    tierReason = 'Archived repo — forced to New regardless of score';
  } else if (
    composite >= 7.0 &&
    dimensions.alive >= 5.5 &&
    dimensions.legit >= 4.5 &&
    dimensions.solid >= 5.0 &&
    !disqualifiers.includes('NO_LICENSE') &&
    sufficientSignals >= 8
  ) {
    tier = 'verified';
    tierReason = `Score ${composite.toFixed(1)} ≥ 7.0 with strong dimensions across all 4 areas`;
  } else if (composite >= 4.5 && sufficientSignals >= 5) {
    tier = 'established';
    tierReason = `Score ${composite.toFixed(1)} ≥ 4.5 with sufficient signal coverage`;
  } else {
    tier = 'new';
    tierReason = `Score ${composite.toFixed(1)} below threshold or insufficient data`;
  }

  const result = {
    repo: `${owner}/${repo}`,
    mode: isSkillsMode ? 'skills' : 'standard',
    tier,
    tierReason,
    composite: Math.round(composite * 100) / 100,
    dimensions: Object.fromEntries(
      Object.entries(dimensions).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
    signals: Object.fromEntries(
      Object.entries(signals).map(([k, v]) => [k, Math.round(v * 10) / 10])
    ),
    disqualifiers,
    meta: {
      stars: repoData.stargazers_count || 0,
      forks: repoData.forks_count || 0,
      archived,
      license: repoData.license?.spdx_id || 'None',
      pushedAt: repoData.pushed_at,
      description: repoData.description || '',
      npmDownloads: npmDownloads,
      contributors: contributors ? contributors.length : null,
    },
    scannedAt: new Date().toISOString(),
  };

  // Add skill-specific metadata
  if (isSkillsMode) {
    result.skill = {
      type: skillInfo.skillType,
      indicators: skillInfo.indicators,
      specChecks: specResult?.checks || {},
      safety: {
        score: safetyResult?.score ?? null,
        summary: safetyResult?.summary || 'Not scanned',
        findings: safetyResult?.findings || [],
        isBlocked: safetyResult?.isBlocked || false,
      },
      supplyChain: {
        score: supplyChainResult?.score ?? null,
        findings: supplyChainResult?.findings || [],
      },
    };

    // Add frontmatter data if parsed
    if (frontmatter) {
      result.skill.frontmatter = frontmatter;
      result.skill.transparency = transparencyResult || { bonus: 0, details: {} };
    }
  }

  return result;
}

module.exports = { scoreRepo, WEIGHTS, SKILLS_WEIGHTS, DIMENSIONS, SKILLS_DIMENSIONS };
