#!/usr/bin/env node
/**
 * Batch scan all registry repos to seed the score cache.
 * Usage: node scripts/batch-scan.js
 */

const { scoreRepo } = require('../lib/scorer');
const { cacheScore, loadScoreCache } = require('../lib/recommender');

const token = process.env.GITHUB_TOKEN || null;

const repos = [
  // ai-sdk
  'anthropics/anthropic-sdk-python', 'openai/openai-node', 'chroma-core/chroma', 'promptfoo/promptfoo',
  // mcp
  'modelcontextprotocol/python-sdk', 'punkpeye/awesome-mcp-servers',
  // database
  'drizzle-team/drizzle-orm', 'supabase/supabase-js', 'knex/knex', 'typeorm/typeorm',
  // auth
  'nextauthjs/next-auth', 'clerk/javascript', 'panva/jose', 'lucia-auth/lucia', 'arcjet/arcjet-js',
  // payments
  'stripe/react-stripe-js', 'lmsqueezy/lemonsqueezy.js',
  // ui
  'shadcn-ui/ui', 'radix-ui/primitives', 'motiondivision/motion', 'react-hook-form/react-hook-form',
  // email
  'resend/resend-node', 'resend/react-email', 'nodemailer/nodemailer',
  // testing
  'vitest-dev/vitest', 'microsoft/playwright', 'cypress-io/cypress', 'eslint/eslint',
  // devops
  'pulumi/pulumi', 'open-telemetry/opentelemetry-js',
  // web frameworks
  'vercel/next.js', 'honojs/hono', 'fastify/fastify', 'expressjs/express',
  // validation
  'colinhacks/zod', 'ajv-validator/ajv',
];

async function main() {
  const cache = loadScoreCache();
  const toScan = repos.filter(r => !cache[r]);
  console.log(`Already cached: ${repos.length - toScan.length}`);
  console.log(`To scan: ${toScan.length}`);
  console.log('');

  let success = 0, fail = 0;
  for (const r of toScan) {
    const [o, n] = r.split('/');
    process.stdout.write(`${r} ... `);
    try {
      const result = await scoreRepo(o, n, token);
      if (result.error) {
        console.log(`SKIP: ${result.error}`);
        fail++;
      } else {
        cacheScore(result);
        console.log(`${result.composite} ${result.tier}`);
        success++;
      }
    } catch (e) {
      console.log(`ERR: ${e.message}`);
      fail++;
    }
  }

  console.log(`\nDone. Scanned: ${success} | Failed: ${fail} | Total cached: ${Object.keys(loadScoreCache()).length}`);
}

main();
