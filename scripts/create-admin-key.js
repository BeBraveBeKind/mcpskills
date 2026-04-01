#!/usr/bin/env node
/**
 * Generate an unlimited Pro API key for admin use.
 * Run with: npx netlify-cli blobs or directly via Netlify Blobs API.
 *
 * Usage: NETLIFY_SITE_ID=<id> NETLIFY_AUTH_TOKEN=<pat> node scripts/create-admin-key.js
 */

const crypto = require('crypto');

const EMAIL = process.env.ADMIN_EMAIL || 'admin@mcpskills.io';

function generateKeyString() {
  return 'msk_' + crypto.randomBytes(16).toString('hex');
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function main() {
  const { getStore } = require('@netlify/blobs');

  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;

  if (!siteID) {
    console.error('Need NETLIFY_SITE_ID env var.');
    console.error('Run: NETLIFY_SITE_ID=<id> NETLIFY_AUTH_TOKEN=<pat> node scripts/create-admin-key.js');
    process.exit(1);
  }

  if (!token) {
    console.error('Need a Netlify personal access token.');
    console.error('Run: NETLIFY_AUTH_TOKEN=<pat> node scripts/create-admin-key.js');
    console.error('Create one at: https://app.netlify.com/user/applications#personal-access-tokens');
    process.exit(1);
  }

  const store = getStore({ name: 'api-keys', siteID, token });
  const key = generateKeyString();
  const keyHash = hashKey(key);

  const record = {
    email: EMAIL,
    credits: null, // unlimited
    source: 'admin',
    tier: 'pro',
    keyPrefix: key.slice(0, 12),
    createdAt: new Date().toISOString(),
    lastUsed: null,
    totalUsed: 0,
  };

  await store.set(keyHash, JSON.stringify(record));

  console.log('\n=== Admin API Key Created ===');
  console.log(`Key:     ${key}`);
  console.log(`Tier:    Pro (unlimited)`);
  console.log(`Email:   ${EMAIL}`);
  console.log(`Hash:    ${keyHash}`);
  console.log(`Prefix:  ${key.slice(0, 12)}`);
  console.log('\nAdd to .env:');
  console.log(`MCPSKILLS_API_KEY=${key}`);
  console.log('\nUse with: curl -H "X-API-Key: ${key}" https://mcpskills.io/api/score');
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error('\nMake sure you run this via: netlify dev:exec node scripts/create-admin-key.js');
  console.error('Or set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN env vars.');
  process.exit(1);
});
