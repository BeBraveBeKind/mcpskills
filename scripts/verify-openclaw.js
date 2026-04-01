#!/usr/bin/env node
/**
 * Verify MCP Skills detection works on real OpenClaw/ClawHub skill repos.
 * Tests detectSkill() and scoreSkillSpecCompliance() against actual GitHub data.
 * Lightweight: 2-3 API calls per repo (tree + package.json + SKILL.md).
 */

const { detectSkill, scoreSkillSpecCompliance } = require('../lib/skills');

const TEST_REPOS = [
  // Standalone OpenClaw skills (should have SKILL.md)
  'prompt-security/clawsec',
  'ythx-101/x-tweet-fetcher',
  'zscole/model-hierarchy-skill',
  'sharbelxyz/x-bookmarks',
  'blessonism/openclaw-search-skills',
  'oh-ashen-one/reddit-growth-skill',
  'Decodo/decodo-openclaw-skill',
  'rohunvora/x-research-skill',
  'RamithaW/openclaw-skill-n8n',
  'joinmassive/clawpod',
  // Core OpenClaw repos (for comparison)
  'openclaw/clawhub',
  'openclaw/skills',
];

const ghApi = async (path) => {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'MCPSkills-Verifier/1.0',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      console.error('⚠️  GitHub rate limit hit. Set GITHUB_TOKEN to continue.');
      process.exit(1);
    }
    return null;
  }
  return await res.json();
};

const fetchFileContent = async (owner, repo, filepath) => {
  const data = await ghApi(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filepath)}`);
  if (!data || !data.content) return null;
  try {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch { return null; }
};

async function verifyRepo(slug) {
  const [owner, repo] = slug.split('/');

  // 1. Fetch repo metadata
  const repoData = await ghApi(`/repos/${owner}/${repo}`);
  if (!repoData) {
    return { slug, error: 'Repo not found or API error' };
  }

  // 2. Fetch file tree
  const branch = repoData.default_branch || 'main';
  const treeData = await ghApi(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
  if (!treeData) {
    return { slug, error: 'Could not fetch tree' };
  }

  // 3. Check for SKILL.md in tree
  const files = (treeData.tree || []).map(f => f.path || '');
  const skillMdFiles = files.filter(f => /skill\.md$/i.test(f));

  // 4. Fetch package.json content (if exists)
  const hasPackageJson = files.some(f => f === 'package.json');
  let packageJsonContent = null;
  if (hasPackageJson) {
    packageJsonContent = await fetchFileContent(owner, repo, 'package.json');
  }

  // 5. Run detectSkill()
  const detection = detectSkill(treeData, packageJsonContent, repoData);

  // 6. Fetch SKILL.md content for spec compliance check
  let skillMdContent = null;
  const rootSkillMd = skillMdFiles.find(f => f.toLowerCase() === 'skill.md');
  if (rootSkillMd) {
    skillMdContent = await fetchFileContent(owner, repo, rootSkillMd);
  }

  // 7. Run scoreSkillSpecCompliance()
  const compliance = scoreSkillSpecCompliance(treeData, skillMdContent, null, packageJsonContent);

  // 8. Check SKILL.md format (YAML frontmatter vs plain markdown)
  let skillMdFormat = null;
  if (skillMdContent) {
    if (skillMdContent.startsWith('---')) {
      skillMdFormat = 'YAML frontmatter';
      // Extract frontmatter fields
      const fmMatch = skillMdContent.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const hasRequires = fm.includes('requires');
        const hasName = fm.includes('name:');
        const hasDesc = fm.includes('description:');
        skillMdFormat += ` (name:${hasName}, desc:${hasDesc}, requires:${hasRequires})`;
      }
    } else {
      skillMdFormat = 'Plain markdown (no frontmatter)';
    }
  }

  return {
    slug,
    stars: repoData.stargazers_count,
    topics: repoData.topics?.slice(0, 5) || [],
    description: (repoData.description || '').substring(0, 80),
    skillMdFiles: skillMdFiles.length,
    skillMdPaths: skillMdFiles.slice(0, 3),
    skillMdFormat,
    detection,
    compliance,
    skillMdPreview: skillMdContent ? skillMdContent.substring(0, 300) : null,
  };
}

async function main() {
  console.log('MCP Skills — OpenClaw Detection Verification');
  console.log('=' .repeat(60));
  console.log(`Testing ${TEST_REPOS.length} repos...\n`);

  const results = [];
  for (const slug of TEST_REPOS) {
    process.stdout.write(`Scanning ${slug}... `);
    const result = await verifyRepo(slug);
    if (result.error) {
      console.log(`❌ ${result.error}`);
    } else {
      const mode = result.detection.isSkill ? '✅ Skills Mode' : '❌ Standard Mode';
      console.log(`${mode} | type=${result.detection.skillType} | SKILL.md=${result.skillMdFiles} | compliance=${result.compliance.score}/10`);
    }
    results.push(result);

    // Small delay to avoid rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  // Summary
  console.log('\n' + '=' .repeat(60));
  console.log('DETAILED RESULTS\n');

  for (const r of results) {
    if (r.error) {
      console.log(`❌ ${r.slug}: ${r.error}\n`);
      continue;
    }

    console.log(`📦 ${r.slug} (⭐ ${r.stars})`);
    console.log(`   Description: ${r.description}`);
    console.log(`   Topics: ${r.topics.join(', ') || '(none)'}`);
    console.log(`   SKILL.md files: ${r.skillMdFiles} ${r.skillMdPaths.length ? '(' + r.skillMdPaths.join(', ') + ')' : ''}`);
    console.log(`   SKILL.md format: ${r.skillMdFormat || 'N/A'}`);
    console.log(`   Detection: isSkill=${r.detection.isSkill}, type=${r.detection.skillType}`);
    console.log(`   Indicators: ${r.detection.indicators.join(', ')}`);
    console.log(`   Spec Compliance: ${r.compliance.score}/10`);
    console.log(`   Checks: ${JSON.stringify(r.compliance.checks)}`);
    if (r.skillMdPreview) {
      console.log(`   SKILL.md preview:`);
      console.log(`   ${r.skillMdPreview.replace(/\n/g, '\n   ').substring(0, 200)}...`);
    }
    console.log();
  }

  // Summary stats
  const detected = results.filter(r => r.detection?.isSkill);
  const withSkillMd = results.filter(r => r.skillMdFiles > 0);
  const withFrontmatter = results.filter(r => r.skillMdFormat?.includes('YAML'));
  const errors = results.filter(r => r.error);

  console.log('=' .repeat(60));
  console.log('SUMMARY');
  console.log(`Total repos tested: ${results.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Has SKILL.md: ${withSkillMd.length}/${results.length - errors.length}`);
  console.log(`YAML frontmatter: ${withFrontmatter.length}/${withSkillMd.length}`);
  console.log(`Detected as Skill: ${detected.length}/${results.length - errors.length}`);
  console.log(`Detection rate: ${((detected.length / (results.length - errors.length)) * 100).toFixed(0)}%`);
}

main().catch(console.error);
