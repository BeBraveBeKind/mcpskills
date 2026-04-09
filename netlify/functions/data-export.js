/**
 * GET /data/latest.json
 * GET /data/latest.csv
 *
 * Public, researcher-friendly data export of every scored repo in the
 * Netlify Blobs score-cache store. Generated on-demand and CDN-cached
 * for 6 hours so bot traffic doesn't hammer the blob store.
 *
 * Why this is a flywheel: researchers cite datasets. If MCP Skills is the
 * canonical trust-score dataset for AI skills, academic citations drive
 * authoritative backlinks that compound far beyond manual outreach.
 *
 * License: CC BY 4.0 — requires attribution to mcpskills.io.
 */

const { connectLambda, getStore } = require('@netlify/blobs');

// Dataset columns (stable contract for consumers — don't reorder without
// bumping the version field in the JSON envelope).
const CSV_COLUMNS = [
  'key',
  'type',
  'repo',
  'package',
  'composite',
  'tier',
  'mode',
  'limited',
  'stars',
  'forks',
  'license',
  'description',
  'scannedAt',
  'discoveredVia',
];

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowToCsv(row) {
  return CSV_COLUMNS.map(c => csvEscape(row[c])).join(',');
}

async function loadAllScores() {
  const rows = [];
  try {
    const store = getStore('score-cache');
    const { blobs } = await store.list();
    for (const b of blobs) {
      try {
        const raw = await store.get(b.key);
        if (!raw) continue;
        const record = JSON.parse(raw);
        const isNpm = b.key.startsWith('npm:');
        rows.push({
          key: b.key,
          type: isNpm ? 'npm' : 'github',
          repo: isNpm ? null : b.key,
          package: isNpm ? b.key.slice(4) : null,
          composite: record.composite ?? null,
          tier: record.tier || null,
          mode: record.mode || null,
          limited: !!record.limited,
          stars: record.meta?.stars ?? null,
          forks: record.meta?.forks ?? null,
          license: record.meta?.license || null,
          description: record.meta?.description || '',
          scannedAt: record.scannedAt || null,
          discoveredVia: record.discoveredVia || 'crawler',
        });
      } catch {}
    }
  } catch {}
  // Sort by composite descending so top repos appear first
  rows.sort((a, b) => (b.composite || 0) - (a.composite || 0));
  return rows;
}

function tierCounts(rows) {
  const counts = { verified: 0, established: 0, new: 0, blocked: 0 };
  for (const r of rows) {
    if (r.tier && counts[r.tier] != null) counts[r.tier]++;
  }
  return counts;
}

function parseFormat(event) {
  // Route via pathname first, query string as fallback
  const path = (event.path || '').toLowerCase();
  if (path.endsWith('.csv')) return 'csv';
  if (path.endsWith('.json')) return 'json';
  const q = (event.queryStringParameters?.format || '').toLowerCase();
  if (q === 'csv') return 'csv';
  return 'json';
}

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'GET only' };
  }

  const format = parseFormat(event);
  const rows = await loadAllScores();
  const generatedAt = new Date().toISOString();

  const cacheHeaders = {
    'Cache-Control': 'public, max-age=1800, s-maxage=21600', // 30 min browser, 6h CDN
    'Access-Control-Allow-Origin': '*',
    'X-License': 'CC-BY-4.0',
    'X-Attribution': 'Data courtesy of MCP Skills (https://mcpskills.io). CC BY 4.0.',
    'X-Generated-At': generatedAt,
    'X-Row-Count': String(rows.length),
  };

  if (format === 'csv') {
    // RFC 4180 CSV with a license header comment (common convention for
    // researcher datasets — Excel ignores lines starting with #)
    const header = [
      `# MCP Skills Trust Scores — generated ${generatedAt}`,
      `# License: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/`,
      `# Attribution: Data courtesy of MCP Skills (https://mcpskills.io)`,
      `# Rows: ${rows.length}`,
      CSV_COLUMNS.join(','),
      ...rows.map(rowToCsv),
    ].join('\n');

    return {
      statusCode: 200,
      headers: {
        ...cacheHeaders,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="mcpskills-trust-scores-${generatedAt.slice(0, 10)}.csv"`,
      },
      body: header,
    };
  }

  // JSON envelope with dataset metadata + license + summary
  const envelope = {
    dataset: {
      name: 'MCP Skills Trust Scores',
      description: 'Public trust score dataset for AI skills, MCP servers, and npm packages — 14 signals across 4 dimensions (Alive, Legit, Solid, Usable).',
      version: '1',
      generatedAt,
      rowCount: rows.length,
      license: 'CC-BY-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: 'Data courtesy of MCP Skills (https://mcpskills.io). CC BY 4.0.',
      source: 'https://mcpskills.io',
      methodology: 'https://mcpskills.io/methodology',
      citation: {
        apa: `MCP Skills. (${new Date().getFullYear()}). MCP Skills Trust Scores [Data set]. https://mcpskills.io/data/latest.json`,
      },
    },
    summary: {
      total: rows.length,
      tiers: tierCounts(rows),
      averageScore: rows.length > 0
        ? +(rows.reduce((a, r) => a + (r.composite || 0), 0) / rows.length).toFixed(2)
        : 0,
    },
    rows,
  };

  return {
    statusCode: 200,
    headers: {
      ...cacheHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(envelope, null, 2),
  };
};
