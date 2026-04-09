/**
 * GET /digest             → latest weekly digest
 * GET /digest/YYYY-WNN    → specific week
 *
 * Renders the weekly-digests Blob store as public, crawlable HTML.
 * This is the content flywheel: weekly-digest.js writes the JSON, this
 * function serves it to Google/AI crawlers and human readers, movers
 * link to /score/:repo pages that carry paid CTAs.
 *
 * If the digest blob is missing (first-run, or bad fetch), render a
 * static placeholder — never cascade into a 500.
 */

const { connectLambda, getStore } = require('@netlify/blobs');

const TIER_COLOR = {
  verified:    '#34D399',
  established: '#FBBF24',
  new:         '#60A5FA',
  blocked:     '#F87171',
};

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseWeekKey(pathname) {
  // /digest                    → null (latest)
  // /digest/2026-W15           → "digest:2026-W15"
  // /.netlify/functions/digest-page/2026-W15 → same
  const match = (pathname || '').match(/(?:digest|digest-page)\/([A-Z0-9-]+)$/i);
  if (!match) return null;
  // Accept "2026-W15" or "digest:2026-W15"
  const raw = match[1];
  return raw.startsWith('digest:') ? raw : `digest:${raw}`;
}

async function loadDigest(key) {
  try {
    const store = getStore('weekly-digests');
    const raw = await store.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function renderPlaceholder(requestedKey) {
  const title = requestedKey
    ? `Digest ${escapeHtml(requestedKey.replace('digest:', ''))} not found — MCP Skills`
    : 'Weekly Digest — regenerating — MCP Skills';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="robots" content="noindex">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="container" style="padding-top:64px;">
    <h1 style="font-size:28px;margin-bottom:16px;">Weekly digest is regenerating</h1>
    <p style="color:var(--text2);margin-bottom:24px;">Our weekly digest runs Sundays at 18:00 UTC. Check back shortly, or explore <a href="/">scored repos</a> directly.</p>
    <a href="/" style="display:inline-block;padding:12px 24px;background:var(--green);color:#000;border-radius:8px;font-weight:600;">← Back to MCP Skills</a>
  </div>
</body>
</html>`;
}

function tierPill(tier, score) {
  const color = TIER_COLOR[tier] || TIER_COLOR.new;
  return `<span class="dg-pill" style="background:${color}1A;color:${color};">${score != null ? score.toFixed(1) : '—'} ${tier || 'new'}</span>`;
}

function renderTierBar(tiers, total) {
  if (!total) return '';
  const segments = ['verified', 'established', 'new', 'blocked'];
  const width = 600;
  const height = 36;
  let x = 0;
  const rects = segments.map(t => {
    const count = tiers[t] || 0;
    const w = Math.round((count / total) * width);
    const rect = `<rect x="${x}" y="0" width="${w}" height="${height}" fill="${TIER_COLOR[t]}" rx="2"/>`;
    x += w;
    return rect;
  }).join('');
  const legend = segments.map(t =>
    `<span class="dg-legend"><span class="dg-swatch" style="background:${TIER_COLOR[t]};"></span>${t} (${tiers[t] || 0})</span>`
  ).join('');
  return `<svg viewBox="0 0 ${width} ${height}" class="dg-tierbar" preserveAspectRatio="none" role="img" aria-label="Tier distribution">${rects}</svg><div class="dg-legend-row">${legend}</div>`;
}

function renderMoverRow(m) {
  const arrow = m.direction === 'up' ? '▲' : '▼';
  const color = m.direction === 'up' ? '#34D399' : '#F87171';
  const repoLink = `/score/${encodeURI(m.repo)}`;
  return `<tr>
    <td><a href="${repoLink}">${escapeHtml(m.repo)}</a></td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;">${m.from?.toFixed(1) ?? '—'}</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;">${m.to?.toFixed(1) ?? '—'}</td>
    <td style="text-align:right;color:${color};font-weight:600;">${arrow} ${Math.abs(m.delta).toFixed(2)}</td>
  </tr>`;
}

function renderRepoListRow(r) {
  const repoLink = `/score/${encodeURI(r.repo)}`;
  return `<tr>
    <td><a href="${repoLink}">${escapeHtml(r.repo)}</a></td>
    <td style="text-align:right;">${tierPill(r.tier, r.score)}</td>
  </tr>`;
}

function renderDigest(digest) {
  const weekKey = digest.weekKey || 'digest:latest';
  const weekDisplay = weekKey.replace('digest:', '');
  const s = digest.summary || {};
  const total = s.totalRepos || 0;
  const tiers = s.tierDistribution || {};
  const modes = s.modeDistribution || {};
  const avgScore = s.avgScore != null ? s.avgScore.toFixed(2) : '—';
  const movers = digest.biggestMovers || [];
  const upMovers = movers.filter(m => m.direction === 'up');
  const downMovers = movers.filter(m => m.direction === 'down');
  const topRepos = digest.topRepos || [];
  const newThisWeek = digest.newThisWeek || [];
  const concerns = digest.securityConcerns || [];
  const hooks = digest.narrativeHooks || [];

  const canonical = `https://mcpskills.io/digest/${encodeURI(weekDisplay)}`;
  const title = `Weekly Trust Digest — ${weekDisplay} | MCP Skills`;
  const description = hooks.slice(0, 2).join('. ').slice(0, 160) || `${total} AI skills and MCP servers scored. Average trust ${avgScore}/10.`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Report',
        'name': `Weekly Trust Digest ${weekDisplay}`,
        'datePublished': digest.generatedAt,
        'reportNumber': weekDisplay,
        'about': 'AI skill and MCP server trust analysis',
        'author': { '@type': 'Organization', 'name': 'MCP Skills', 'url': 'https://mcpskills.io' },
        'publisher': { '@type': 'Organization', 'name': 'MCP Skills', 'url': 'https://mcpskills.io' },
        'description': description,
      },
      {
        '@type': 'BreadcrumbList',
        'itemListElement': [
          { '@type': 'ListItem', 'position': 1, 'name': 'MCP Skills', 'item': 'https://mcpskills.io' },
          { '@type': 'ListItem', 'position': 2, 'name': 'Weekly Digest', 'item': 'https://mcpskills.io/digest' },
          { '@type': 'ListItem', 'position': 3, 'name': weekDisplay, 'item': canonical },
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
  <link rel="canonical" href="${canonical}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonical}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="alternate" type="application/rss+xml" title="MCP Skills Weekly Digest" href="https://mcpskills.io/digest/rss.xml">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <script defer data-domain="mcpskills.io" src="https://plausible.io/js/script.js"></script>
  <style>
    .dg-hero { padding: 48px 0 24px; border-bottom: 1px solid var(--border); }
    .dg-crumbs { color: var(--text3); font-size: 13px; margin-bottom: 16px; }
    .dg-crumbs a { color: var(--text2); }
    .dg-title { font-size: 32px; font-weight: 700; margin-bottom: 8px; }
    .dg-sub { color: var(--text2); font-size: 15px; margin-bottom: 24px; }
    .dg-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; margin: 24px 0; }
    .dg-stat { background: var(--surface); padding: 16px; border-radius: 8px; border: 1px solid var(--border); }
    .dg-stat-label { color: var(--text3); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .dg-stat-val { font-size: 24px; font-weight: 700; }
    .dg-section { padding: 32px 0; border-bottom: 1px solid var(--border); }
    .dg-section h2 { font-size: 20px; margin-bottom: 16px; }
    .dg-section p { color: var(--text2); margin-bottom: 16px; font-size: 14px; }
    .dg-tierbar { width: 100%; height: 36px; display: block; border-radius: 4px; overflow: hidden; }
    .dg-legend-row { display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; }
    .dg-legend { display: flex; align-items: center; gap: 6px; color: var(--text2); font-size: 13px; text-transform: capitalize; }
    .dg-swatch { width: 12px; height: 12px; border-radius: 2px; display: inline-block; }
    .dg-pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; text-transform: capitalize; }
    .dg-table { width: 100%; border-collapse: collapse; }
    .dg-table th, .dg-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 14px; }
    .dg-table th { color: var(--text3); text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; font-weight: 600; }
    .dg-table a { color: var(--text); }
    .dg-table a:hover { color: var(--green); }
    .dg-cta { background: var(--surface); border: 1px solid var(--border); padding: 24px; border-radius: 12px; text-align: center; margin: 32px 0; }
    .dg-cta h3 { font-size: 18px; margin-bottom: 8px; }
    .dg-cta p { color: var(--text2); font-size: 14px; margin-bottom: 16px; }
    .dg-cta a { display: inline-block; padding: 12px 24px; background: var(--green); color: #000; border-radius: 8px; font-weight: 600; text-decoration: none; }
    .dg-cta a:hover { text-decoration: none; }
    .dg-hook-list { list-style: none; padding: 0; }
    .dg-hook-list li { padding: 8px 0; border-bottom: 1px solid var(--border); color: var(--text2); }
    .dg-hook-list li:last-child { border-bottom: none; }
    .dg-footer { text-align: center; padding: 48px 0; color: var(--text3); font-size: 13px; }
    .dg-footer a { color: var(--text2); }
  </style>
</head>
<body>
  <div class="container" style="max-width:820px;">
    <section class="dg-hero">
      <nav class="dg-crumbs"><a href="/">MCP Skills</a> / <a href="/digest">Weekly Digest</a> / ${escapeHtml(weekDisplay)}</nav>
      <h1 class="dg-title">Weekly Trust Digest — ${escapeHtml(weekDisplay)}</h1>
      <p class="dg-sub">${total} repos scored · average trust ${avgScore}/10 · ${Math.round(((modes.skills || 0) / (total || 1)) * 100)}% AI skills · generated ${digest.generatedAt ? new Date(digest.generatedAt).toISOString().slice(0, 10) : ''}</p>
    </section>

    <section class="dg-section">
      <h2>Summary</h2>
      <div class="dg-stats">
        <div class="dg-stat"><div class="dg-stat-label">Total scored</div><div class="dg-stat-val">${total}</div></div>
        <div class="dg-stat"><div class="dg-stat-label">Average</div><div class="dg-stat-val">${avgScore}</div></div>
        <div class="dg-stat"><div class="dg-stat-label">Verified</div><div class="dg-stat-val" style="color:${TIER_COLOR.verified};">${tiers.verified || 0}</div></div>
        <div class="dg-stat"><div class="dg-stat-label">Blocked</div><div class="dg-stat-val" style="color:${TIER_COLOR.blocked};">${tiers.blocked || 0}</div></div>
      </div>
      ${renderTierBar(tiers, total)}
    </section>

    ${hooks.length > 0 ? `
    <section class="dg-section">
      <h2>Headlines</h2>
      <ul class="dg-hook-list">
        ${hooks.map(h => `<li>${escapeHtml(h)}</li>`).join('')}
      </ul>
    </section>
    ` : ''}

    ${movers.length > 0 ? `
    <section class="dg-section">
      <h2>Biggest movers this week</h2>
      <p>Repos whose trust score changed by 0.3 or more over the last 7 days.</p>
      <table class="dg-table">
        <thead><tr><th>Repo</th><th style="text-align:right;">Was</th><th style="text-align:right;">Now</th><th style="text-align:right;">Δ</th></tr></thead>
        <tbody>${movers.map(renderMoverRow).join('')}</tbody>
      </table>
      <div class="dg-cta">
        <h3>Get alerts when repos drop 0.3+</h3>
        <p>Pro monitoring re-scans your tracked repos daily and emails you when trust scores shift. $12/mo, cancel anytime.</p>
        <a href="/#pricing">Upgrade to Pro →</a>
      </div>
    </section>
    ` : ''}

    ${topRepos.length > 0 ? `
    <section class="dg-section">
      <h2>Top repos by trust score</h2>
      <table class="dg-table">
        <thead><tr><th>Repo</th><th style="text-align:right;">Trust</th></tr></thead>
        <tbody>${topRepos.map(renderRepoListRow).join('')}</tbody>
      </table>
    </section>
    ` : ''}

    ${newThisWeek.length > 0 ? `
    <section class="dg-section">
      <h2>New this week (${newThisWeek.length})</h2>
      <p>Repos discovered and scored in the last 7 days. Showing ${Math.min(newThisWeek.length, 15)}.</p>
      <table class="dg-table">
        <thead><tr><th>Repo</th><th style="text-align:right;">Trust</th></tr></thead>
        <tbody>${newThisWeek.slice(0, 15).map(renderRepoListRow).join('')}</tbody>
      </table>
    </section>
    ` : ''}

    ${concerns.length > 0 ? `
    <section class="dg-section">
      <h2>Security concerns</h2>
      <p>Repos currently blocked or scoring below 4.0 — review before installing.</p>
      <table class="dg-table">
        <thead><tr><th>Repo</th><th style="text-align:right;">Trust</th></tr></thead>
        <tbody>${concerns.slice(0, 10).map(renderRepoListRow).join('')}</tbody>
      </table>
    </section>
    ` : ''}

    <footer class="dg-footer">
      <a href="/digest/rss.xml">RSS feed</a> · <a href="/data/latest.json">Data export</a> · <a href="/">mcpskills.io</a>
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

  const requestedKey = parseWeekKey(event.path);
  const blobKey = requestedKey || 'latest';
  const digest = await loadDigest(blobKey);

  if (!digest) {
    return {
      statusCode: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: renderPlaceholder(requestedKey),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=1800, s-maxage=21600',
    },
    body: renderDigest(digest),
  };
};
