/**
 * POST /.netlify/functions/score
 * Score a single GitHub repo against the MCP Skills trust algorithm.
 *
 * Body: { "repo": "owner/repo" }
 * Returns: Full trust score JSON
 */

const { scoreRepo } = require('../../lib/scorer');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const repoPath = body.repo;
  if (!repoPath || !repoPath.includes('/')) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Missing or invalid "repo" field. Expected format: "owner/repo"',
      }),
    };
  }

  const [owner, repo] = repoPath.split('/');
  const token = process.env.GITHUB_TOKEN || null;

  try {
    const result = await scoreRepo(owner, repo, token);

    if (result.error) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: result.error }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal scoring error', details: err.message }),
    };
  }
};
