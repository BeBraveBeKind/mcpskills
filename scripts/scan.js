#!/usr/bin/env node
/**
 * MCP Skills Daily Scan
 * Scores all repos in all packages and writes the scored cache.
 *
 * Usage: GITHUB_TOKEN=ghp_xxx node scripts/scan.js
 *
 * Run as: Netlify Scheduled Function, GitHub Action cron, or manual.
 * Output: data/packages-scored.json
 */

const fs = require('fs');
const path = require('path');
const { scoreRepo } = require('../lib/scorer');

const PACKAGES_PATH = path.join(__dirname, '..', 'data', 'packages.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'packages-scored.json');

// Rate limit: pause between repos to stay under GitHub API limits
const DELAY_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const token = process.env.GITHUB_TOKEN || null;
  if (!token) {
    console.warn('⚠️  No GITHUB_TOKEN set. Using unauthenticated API (60 req/hr limit).');
    console.warn('   Set GITHUB_TOKEN for 5,000 req/hr.\n');
  }

  const packages = JSON.parse(fs.readFileSync(PACKAGES_PATH, 'utf-8'));
  const totalRepos = packages.packages.reduce((sum, p) => sum + p.repos.length, 0);

  console.log(`MCP Skills Scanner — ${new Date().toISOString()}`);
  console.log(`Scanning ${totalRepos} repos across ${packages.packages.length} packages\n`);

  const scoredPackages = [];
  let scored = 0;
  let errors = 0;

  for (const pkg of packages.packages) {
    console.log(`\n📦 ${pkg.name}`);
    console.log(`   ${pkg.tagline}`);

    const scoredRepos = [];

    for (const repoEntry of pkg.repos) {
      const { owner, repo, role } = repoEntry;
      process.stdout.write(`   Scoring ${owner}/${repo}...`);

      try {
        const result = await scoreRepo(owner, repo, token);

        if (result.error) {
          console.log(` ❌ ${result.error}`);
          scoredRepos.push({ ...repoEntry, score: null, error: result.error });
          errors++;
        } else {
          const emoji = result.tier === 'verified' ? '✅' :
                        result.tier === 'established' ? '🟡' : '🔵';
          console.log(` ${emoji} ${result.tier} (${result.composite})`);
          scoredRepos.push({
            ...repoEntry,
            score: {
              tier: result.tier,
              tierReason: result.tierReason,
              composite: result.composite,
              dimensions: result.dimensions,
              signals: result.signals,
              disqualifiers: result.disqualifiers,
              meta: result.meta,
            },
          });
          scored++;
        }
      } catch (err) {
        console.log(` ❌ Error: ${err.message}`);
        scoredRepos.push({ ...repoEntry, score: null, error: err.message });
        errors++;
      }

      await sleep(DELAY_MS);
    }

    // Package-level stats
    const verified = scoredRepos.filter(r => r.score?.tier === 'verified').length;
    const established = scoredRepos.filter(r => r.score?.tier === 'established').length;
    const newTier = scoredRepos.filter(r => r.score?.tier === 'new').length;

    scoredPackages.push({
      ...pkg,
      repos: scoredRepos,
      stats: {
        total: scoredRepos.length,
        verified,
        established,
        new: newTier,
        errors: scoredRepos.filter(r => r.score === null).length,
      },
      scannedAt: new Date().toISOString(),
    });
  }

  // Write output
  const output = {
    packages: scoredPackages,
    meta: {
      scannedAt: new Date().toISOString(),
      totalRepos: totalRepos,
      scored,
      errors,
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Scan complete: ${scored} scored, ${errors} errors`);
  console.log(`Output: ${OUTPUT_PATH}`);

  // Summary table
  console.log(`\nPackage Summary:`);
  for (const pkg of scoredPackages) {
    console.log(`  ${pkg.name}: ${pkg.stats.verified}✅ ${pkg.stats.established}🟡 ${pkg.stats.new}🔵`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
