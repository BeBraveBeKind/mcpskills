/**
 * GET /.netlify/functions/card?package=cold-outbound-stack
 * Renders a LinkedIn-shareable PNG card for a skill package.
 *
 * Returns: image/png (1200x630)
 *
 * Also usable as og:image:
 *   <meta property="og:image" content="https://mcpskills.io/.netlify/functions/card?package=cold-outbound-stack" />
 */

const fs = require('fs');
const path = require('path');
const { renderCard } = require('../../lib/card');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed. Use GET.' }),
    };
  }

  const packageId = event.queryStringParameters?.package;
  if (!packageId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Missing "package" query parameter',
        example: '/.netlify/functions/card?package=cold-outbound-stack',
        available: [
          'cold-outbound-stack',
          'ai-agent-starter',
          'auth-security-stack',
          'payment-billing-stack',
          'landing-page-launcher',
        ],
      }),
    };
  }

  // Load package data (scored if available, base otherwise)
  let data;
  const scoredPath = path.join(__dirname, '..', '..', 'data', 'packages-scored.json');
  const basePath = path.join(__dirname, '..', '..', 'data', 'packages.json');

  try {
    const filePath = fs.existsSync(scoredPath) ? scoredPath : basePath;
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not load package data' }),
    };
  }

  const pkg = data.packages.find(p => p.id === packageId);
  if (!pkg) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `Package "${packageId}" not found`,
        available: data.packages.map(p => p.id),
      }),
    };
  }

  try {
    const pngBuffer = await renderCard(pkg);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400', // Cache 24 hours
        'Content-Length': pngBuffer.length.toString(),
      },
      body: pngBuffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Card rendering failed',
        details: err.message,
      }),
    };
  }
};
