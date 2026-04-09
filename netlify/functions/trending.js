/**
 * GET /trending          → HTML (free tier: top 10 each direction)
 * GET /api/trending      → JSON (agents/API, honors auth)
 *
 * Reads score-history to compute repo movers over the last 7 and 30 days,
 * then renders either an HTML page (SEO bait) or a JSON response.
 * Free tier sees the top 10 up/down movers; Pro API keys unlock the full
 * top 50 in each direction.
 *
 * Cached 6h at the CDN layer so repeated crawler hits don't thrash the
 * blob store.
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { authenticateRequest } = require('../../lib/auth');

const BUDGET_MS = 7000;
const FREE_LIMIT = 10;
const PRO_LIMIT = 50;

function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Load the current score for every repo in score-cache, then look up a
 * historical snapshot from N days ago for each and compute deltas.
 *
 * Returns { up: Mover[], down: Mover[] } sorted by |delta| desc.
 * Time-budgeted so it never exceeds the 7s window.
 */
async function computeMovers(daysBack) {
  const startTime = Date.now();
  const cacheStore = getStore('score-cache');
  const historyStore = getStore('score-history');
  const histDate = daysAgoIso(daysBack);

  const movers = [];

  let repos = [];
  try {
    const { blobs } = await cacheStore.list();
    repos = blobs.map(b => b.key);
  } catch {
    return { up: [], down: [] };
  }

  for (const key of repos) {
    if (Date.now() - startTime > BUDGET_MS) break;

    let current, historical;
    try {
      const raw = await cacheStore.get(key);
      if (!raw) continue;
      current = JSON.parse(raw);
    } catch { continue; }

    // Look up the historical snapshot for the target date.
    // score-history key shape: `{repo}:{YYYY-MM-DD}` (repo already lowercase)
    try {
      const histKey = `${key}:${histDate}`;
      const histRaw = await historyStore.get(histKey);
      if (!histRaw) continue;
      historical = JSON.parse(histRaw);
    } catch { continue; }

    const from = historical.composite;
    const to = current.composite;
    if (typeof from !== 'number' || typeof to !== 'number') continue;

    const delta = +(to - from).toFixed(2);
    if (Math.abs(delta) < 0.3) continue; // Only meaningful movements

    movers.push({
      repo: key,
      from: +from.toFixed(2),
      to: +to.toFixed(2),
      delta,
      direction: delta > 0 ? 'up' : 'down',
      tier: current.tier || null,
      mode: current.mode || 'standard',
      description: current.meta?.description || '',
    });
  }

  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    up: movers.filter(m => m.direction === 'up'),
    down: movers.filter(m => m.direction === 'down'),
  };
}

function renderMoverRow(m) {
  const repoLink = `/score/${encodeURI(m.repo)}`;
  const arrow = m.direction === 'up' ? '▲' : '▼';
  const color = m.direction === 'up' ? '#34D399' : '#F87171';
  return `<tr>
    <td><a href="${repoLink}">${escapeHtml(m.repo)}</a></td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--text2);">${m.from.toFixed(1)}</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;">${m.to.toFixed(1)}</td>
    <td style="text-align:right;color:${color};font-weight:600;">${arrow} ${Math.abs(m.delta).toFixed(2)}</td>
  </tr>`;
}

function renderPage({ movers7, limit, tier }) {
  const { up, down } = movers7;
  const shownUp = up.slice(0, limit);
  const shownDown = down.slice(0, limit);
  const hasMore = (up.length > limit || down.length > limit) && tier === 'free';

  const title = 'Trending AI Skills & MCP Servers — Weekly Trust Movers | MCP Skills';
  const description = `Top ${limit} AI skills and MCP servers whose trust scores moved most in the last 7 days. Real-time re-scored daily.`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        'name': 'Trending Trust Movers — 7 day',
        'numberOfItems': shownUp.length + shownDown.length,
        'itemListElement': [...shownUp, ...shownDown].slice(0, 20).map((m, i) => ({
          '@type': 'ListItem',
          'position': i + 1,
          'url': `https://mcpskills.io/score/${encodeURI(m.repo)}`,
          'name': m.repo,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        'itemListElement': [
          { '@type': 'ListItem', 'position': 1, 'name': 'MCP Skills', 'item': 'https://mcpskills.io' },
          { '@type': 'ListItem', 'position': 2, 'name': 'Trending', 'item': 'https://mcpskills.io/trending' },
        ],
      },
    ],
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="https://mcpskills.io/trending">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://mcpskills.io/trending">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <script defer data-domain="mcpskills.io" src="https://plausible.io/js/script.js"></script>
  <style>
    .tr-hero { padding: 48px 0 24px; border-bottom: 1px solid var(--border); }
    .tr-crumbs { color: var(--text3); font-size: 13px; margin-bottom: 16px; }
    .tr-crumbs a { color: var(--text2); }
    .tr-title { font-size: 32px; font-weight: 700; margin-bottom: 8px; }
    .tr-sub { color: var(--text2); font-size: 15px; margin-bottom: 8px; }
    .tr-section { padding: 32px 0; border-bottom: 1px solid var(--border); }
    .tr-section h2 { font-size: 20px; margin-bottom: 8px; }
    .tr-section p { color: var(--text2); font-size: 14px; margin-bottom: 16px; }
    .tr-table { width: 100%; border-collapse: collapse; }
    .tr-table th, .tr-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 14px; }
    .tr-table th { color: var(--text3); text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; font-weight: 600; }
    .tr-table a { color: var(--text); }
    .tr-table a:hover { color: var(--green); }
    .tr-cta { background: var(--surface); border: 1px solid var(--border); padding: 24px; border-radius: 12px; text-align: center; margin: 32px 0; }
    .tr-cta h3 { font-size: 18px; margin-bottom: 8px; }
    .tr-cta p { color: var(--text2); font-size: 14px; margin-bottom: 16px; }
    .tr-cta a { display: inline-block; padding: 12px 24px; background: var(--green); color: #000; border-radius: 8px; font-weight: 600; text-decoration: none; }
    .tr-empty { color: var(--text3); font-size: 14px; padding: 24px; text-align: center; }
    .tr-footer { text-align: center; padding: 48px 0; color: var(--text3); font-size: 13px; }
    .tr-footer a { color: var(--text2); }
  </style>
</head>
<body>
  <div class="container" style="max-width:820px;">
    <section class="tr-hero">
      <nav class="tr-crumbs"><a href="/">MCP Skills</a> / Trending</nav>
      <h1 class="tr-title">Trending Trust Movers — 7 Day</h1>
      <p class="tr-sub">Repos whose trust score changed by 0.3 or more over the last 7 days. Recomputed on every crawler cycle.</p>
    </section>

    <section class="tr-section">
      <h2>↑ Biggest gainers</h2>
      ${shownUp.length > 0 ? `
        <table class="tr-table">
          <thead><tr><th>Repo</th><th style="text-align:right;">Was</th><th style="text-align:right;">Now</th><th style="text-align:right;">Δ</th></tr></thead>
          <tbody>${shownUp.map(renderMoverRow).join('')}</tbody>
        </table>
      ` : '<div class="tr-empty">No gainers in the last 7 days yet. Check back after the next crawler cycle.</div>'}
    </section>

    <section class="tr-section">
      <h2>↓ Biggest drops</h2>
      ${shownDown.length > 0 ? `
        <table class="tr-table">
          <thead><tr><th>Repo</th><th style="text-align:right;">Was</th><th style="text-align:right;">Now</th><th style="text-align:right;">Δ</th></tr></thead>
          <tbody>${shownDown.map(renderMoverRow).join('')}</tbody>
        </table>
      ` : '<div class="tr-empty">No drops in the last 7 days.</div>'}
    </section>

    ${hasMore ? `
      <div class="tr-cta">
        <h3>See the full top ${PRO_LIMIT}</h3>
        <p>Pro includes the full ranked list of movers plus JSON API access for agent integrations. $12/mo, cancel anytime.</p>
        <a href="/#pricing">Upgrade to Pro →</a>
      </div>
    ` : ''}

    <footer class="tr-footer">
      Data from <a href="/data/latest.json">our public dataset</a> · <a href="/digest">Weekly digest</a> · <a href="/">mcpskills.io</a>
    </footer>
  </div>
</body>
</html>`;
}

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/plain' }, body: 'GET only' };
  }

  // Detect response format: /api/trending → JSON, /trending → HTML.
  // Query param ?format=json forces JSON.
  const path = event.path || '';
  const format = (event.queryStringParameters?.format || '').toLowerCase();
  const wantsJson = path.includes('/api/trending') || format === 'json';

  // Authenticate to determine free vs pro limit.
  // We allow anonymous requests — treat failed auth as free.
  let tier = 'free';
  try {
    const auth = await authenticateRequest(event);
    if (auth.authenticated && (auth.tier === 'pro' || auth.tier === 'paid')) {
      tier = auth.tier;
    }
  } catch {}
  const limit = tier === 'free' ? FREE_LIMIT : PRO_LIMIT;

  const movers7 = await computeMovers(7);

  if (wantsJson) {
    const body = {
      window: '7d',
      tier,
      limit,
      up: movers7.up.slice(0, limit),
      down: movers7.down.slice(0, limit),
      totalUp: movers7.up.length,
      totalDown: movers7.down.length,
      upgrade: tier === 'free' && (movers7.up.length > limit || movers7.down.length > limit)
        ? 'Upgrade to Pro at https://mcpskills.io/#pricing for the full top 50 in each direction'
        : undefined,
      generatedAt: new Date().toISOString(),
    };
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': tier === 'free' ? 'public, max-age=1800, s-maxage=21600' : 'private, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(body, null, 2),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=1800, s-maxage=21600',
    },
    body: renderPage({ movers7, limit, tier }),
  };
};
