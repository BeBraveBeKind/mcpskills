/**
 * GET /.netlify/functions/packages
 * Return cached package data with trust scores.
 *
 * Query params:
 *   ?id=cold-outbound-stack  — return single package
 *   (no params)              — return all packages
 */

const fs = require('fs');
const path = require('path');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
  };

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use GET.' }),
    };
  }

  // Try to load scored cache first, fall back to base package data
  let data;
  const cachedPath = path.join(__dirname, '..', '..', 'data', 'packages-scored.json');
  const basePath = path.join(__dirname, '..', '..', 'data', 'packages.json');

  try {
    if (fs.existsSync(cachedPath)) {
      data = JSON.parse(fs.readFileSync(cachedPath, 'utf-8'));
    } else {
      data = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Could not load package data', details: err.message }),
    };
  }

  // Filter by ID if requested
  const packageId = event.queryStringParameters?.id;
  if (packageId) {
    const pkg = data.packages.find(p => p.id === packageId);
    if (!pkg) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: `Package "${packageId}" not found`,
          available: data.packages.map(p => p.id),
        }),
      };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(pkg, null, 2),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(data, null, 2),
  };
};
