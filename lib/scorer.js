/**
 * MCP Skills Trust Scoring Engine
 * 12 signals across 4 dimensions → 3 trust tiers
 * Standard Mode (10 signals) for generic repos
 * Skills Mode (12 signals) for MCP servers and agent skills
 */

const { detectSkill, scoreSkillSpecCompliance, scoreToolSafety, fetchScanTargets } = require('./skills');

// Standard Mode weights (generic repos)
const WEIGHTS = {
  commit_recency: 0.12,
  release_cadence: 0.10,
  issue_responsiveness: 0.08,
  author_credibility: 0.15,
  community_adoption: 0.10,
  security_posture: 0.15,
  dependency_health: 0.10,
  readme_quality: 0.08,
  file_structure: 0.07,
  license_clarity: 0.05,
};

// Skills Mode weights (MCP servers, agent skills)
const SKILLS_WEIGHTS = {
  commit_recency: 0.10,
  release_cadence: 0.08,
  issue_responsiveness: 0.07,
  author_credibility: 0.13,
  community_adoption: 0.08,
  security_posture: 0.12,
  dependency_health: 0.07,
  readme_quality: 0.05,
  skill_spec_compliance: 0.10,  // Signal 11 — replaces file_structure
  license_clarity: 0.05,
  tool_safety: 0.15,            // Signal 12 — new, highest weight
};

const DIMENSIONS = {
  alive: ['commit_recency', 'release_cadence', 'issue_responsiveness'],
  legit: ['author_credibility', 'community_adoption'],
  solid: ['security_posture', 'dependency_health'],
  usable: ['readme_quality', 'file_structure', 'license_clarity'],
};

const SKILLS_DIMENSIONS = {
  alive: ['commit_recency', 'release_cadence', 'issue_responsiveness'],
  legit: ['author_credibility', 'community_adoption'],
  solid: ['security_posture', 'dependency_health', 'tool_safety'],
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

  // Wave 2: Owner + tree + README
  const ownerType = repoData.owner?.type;
  const defaultBranch = repoData.default_branch || 'main';

  const [ownerData, ownerRepos, treeData, readmeData] = await Promise.all([
    ownerType === 'Organization'
      ? ghApi(`/orgs/${owner}`, token)
      : ghApi(`/users/${owner}`, token),
    ghApi(`/users/${owner}/repos?sort=stars&per_page=10`, token),
    ghApi(`/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, token),
    ghApi(`/repos/${owner}/${repo}/readme`, token),
  ]);

  // Decode README
  let readmeContent = '';
  if (readmeData?.content) {
    try {
      readmeContent = Buffer.from(readmeData.content, 'base64').toString('utf-8');
    } catch {}
  }

  // --- Skill Detection ---
  // Fetch package.json content for skill detection
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

  const skillInfo = detectSkill(treeData, packageJsonContent, repoData);
  const isSkillsMode = skillInfo.isSkill;

  // --- Compute base 10 signals (always) ---
  const signals = {
    commit_recency: scoreCommitRecency(repoData),
    release_cadence: scoreReleaseCadence(releases || []),
    issue_responsiveness: scoreIssueResponsiveness(issues || []),
    author_credibility: scoreAuthorCredibility(ownerData, ownerRepos || []),
    community_adoption: scoreCommunityAdoption(repoData),
    security_posture: scoreSecurityPosture(scorecardData, treeData),
    dependency_health: scoreDependencyHealth(treeData),
    readme_quality: scoreReadmeQuality(readmeContent, treeData),
    license_clarity: scoreLicenseClarity(repoData),
  };

  // --- Skills Mode: add Signal 11 + Signal 12 ---
  let safetyResult = null;
  let specResult = null;

  if (isSkillsMode) {
    // Signal 11: Skill Spec Compliance
    let skillMdContent = null;
    let serverJsonContent = null;

    // Fetch SKILL.md if it exists
    const skillMdFile = (treeData?.tree || []).find(f =>
      f.path.toLowerCase() === 'skill.md'
    );
    if (skillMdFile) {
      const data = await ghApi(`/repos/${owner}/${repo}/contents/SKILL.md`, token);
      if (data?.content) {
        try { skillMdContent = Buffer.from(data.content, 'base64').toString('utf-8'); } catch {}
      }
    }

    // Fetch server.json if it exists
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

    // Signal 12: Tool Safety Analysis
    const { fileContents, markdownContents } = await fetchScanTargets(owner, repo, treeData, token);
    safetyResult = scoreToolSafety(fileContents, markdownContents);
    signals.tool_safety = safetyResult.score;
  } else {
    // Standard Mode: use file_structure
    signals.file_structure = scoreFileStructure(treeData);
  }

  // --- Select weight system ---
  const activeWeights = isSkillsMode ? SKILLS_WEIGHTS : WEIGHTS;
  const activeDimensions = isSkillsMode ? SKILLS_DIMENSIONS : DIMENSIONS;

  // Dimension scores
  const dimensions = {};
  for (const [dim, signalNames] of Object.entries(activeDimensions)) {
    const dimWeights = Object.fromEntries(
      signalNames.filter(s => signals[s] !== undefined).map(s => [s, activeWeights[s]])
    );
    const totalDimWeight = Object.values(dimWeights).reduce((a, b) => a + b, 0);
    if (totalDimWeight === 0) { dimensions[dim] = 0; continue; }
    dimensions[dim] = Object.entries(dimWeights).reduce(
      (sum, [s, w]) => sum + signals[s] * (w / totalDimWeight), 0
    );
  }

  // Composite score
  const activeSignals = Object.entries(signals).filter(([s]) => activeWeights[s] !== undefined);
  const totalWeight = activeSignals.reduce((sum, [s]) => sum + activeWeights[s], 0);
  const composite = activeSignals.reduce(
    (sum, [s, val]) => sum + val * (activeWeights[s] / totalWeight), 0
  );

  // Disqualifiers
  const disqualifiers = [];
  const archived = repoData.archived || false;
  if (archived) disqualifiers.push('ARCHIVED');
  if (signals.license_clarity === 0) disqualifiers.push('NO_LICENSE');
  if (signals.security_posture <= 2.0 && !scorecardData) disqualifiers.push('NO_SCORECARD');
  if (isSkillsMode && safetyResult?.isBlocked) disqualifiers.push('SAFETY_BLOCK');

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
    composite >= 7.5 &&
    dimensions.alive >= 6.0 &&
    dimensions.legit >= 5.0 &&
    !disqualifiers.includes('NO_LICENSE') &&
    sufficientSignals >= 6
  ) {
    tier = 'verified';
    tierReason = `Score ${composite.toFixed(1)} ≥ 7.5 with strong dimensions across all 4 areas`;
  } else if (composite >= 4.5 && sufficientSignals >= 4) {
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
    };
  }

  return result;
}

module.exports = { scoreRepo, WEIGHTS, SKILLS_WEIGHTS, DIMENSIONS, SKILLS_DIMENSIONS };
