/**
 * GET /score/owner/repo (or /score/npm:package)
 *
 * Serves a public-facing trust score landing page for any scored repo or package.
 * Each page is independently indexable and targets queries like
 * "[repo] trust score", "is [repo] safe to install", "[repo] security".
 *
 * Cache hierarchy:
 *   1. score-pages Blob store — rich cached page data (dimensions, signals, meta)
 *      with 24h TTL. Hit = instant render.
 *   2. scoreAny() live call — cold path. Persists richer shape to score-pages
 *      so next visitor gets the instant path.
 *
 * The score-pages store is deliberately separate from score-cache to avoid
 * shape drift with the crawler / badge / score.js consumers.
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreAny } = require('../../lib/score-any');
const { tryAutoCertify } = require('../../lib/auto-certify');

const PAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const TIER_INFO = {
  verified:    { label: 'Verified',    color: '#34D399', bg: 'rgba(52,211,153,0.10)',  hint: 'Safe to build on. Strong signals across all dimensions.' },
  established: { label: 'Established', color: '#FBBF24', bg: 'rgba(251,191,36,0.10)',  hint: 'Solid, but check the details before adopting.' },
  new:         { label: 'New',         color: '#60A5FA', bg: 'rgba(96,165,250,0.10)',  hint: 'Promising but unproven. Limited track record.' },
  blocked:     { label: 'Blocked',     color: '#F87171', bg: 'rgba(248,113,113,0.10)', hint: 'Critical safety or supply-chain concerns detected.' },
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

function formatNumber(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/**
 * Parse /score/* pathname into a scoreable input.
 * Examples:
 *   /score/vercel/ai                  → vercel/ai
 *   /score/npm:@hubspot/mcp-server    → npm:@hubspot/mcp-server
 *   /score/@anthropic-ai/sdk          → @anthropic-ai/sdk
 */
function parseInput(pathname) {
  // Strip leading /score/ or /.netlify/functions/score-page/
  let rest = pathname
    .replace(/^\/\.netlify\/functions\/score-page\/?/, '')
    .replace(/^\/score\/?/, '')
    .replace(/\/$/, '');
  if (!rest) return null;
  return decodeURIComponent(rest);
}

async function lookupPageCache(cacheKey) {
  try {
    const store = getStore('score-pages');
    const raw = await store.get(cacheKey);
    if (!raw) return null;
    const record = JSON.parse(raw);
    const age = Date.now() - new Date(record.cachedAt).getTime();
    if (age > PAGE_TTL_MS) return null;
    return record;
  } catch {
    return null;
  }
}

async function savePageCache(cacheKey, result) {
  try {
    const store = getStore('score-pages');
    const record = {
      input: result.resolvedFrom?.input || result.repo || result.package,
      repo: result.repo || null,
      package: result.package || null,
      composite: result.composite,
      tier: result.tier,
      mode: result.mode,
      limited: result.limited || false,
      dimensions: result.dimensions || {},
      meta: result.meta || {},
      disqualifiers: result.disqualifiers || [],
      signalCount: result.signalCount || 0,
      cachedAt: new Date().toISOString(),
    };
    await store.set(cacheKey, JSON.stringify(record));
  } catch {
    // Non-fatal — page renders from live result
  }
}

async function isCertified(cacheKey) {
  try {
    const store = getStore('certifications');
    const raw = await store.get(`cert:${cacheKey}`);
    if (!raw) return false;
    const record = JSON.parse(raw);
    return record.status === 'certified';
  } catch {
    return false;
  }
}

function renderNotFound(input) {
  const safeInput = escapeHtml(input || 'this repo');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Not Scored — MCP Skills</title>
  <meta name="robots" content="noindex">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="container" style="padding-top:64px;">
    <h1 style="font-size:32px;margin-bottom:16px;">Couldn't score ${safeInput}</h1>
    <p style="color:var(--text2);margin-bottom:24px;">We couldn't resolve this input to a scorable repository or package. Try an owner/repo, npm package, or registry URL on <a href="/">mcpskills.io</a>.</p>
    <a href="/" style="display:inline-block;padding:12px 24px;background:var(--green);color:#000;border-radius:8px;font-weight:600;">← Score another</a>
  </div>
</body>
</html>`;
}

function renderPage(record, certified) {
  const input = record.input || record.repo || record.package || 'unknown';
  const displayName = record.repo || record.package || input;
  const tier = record.tier || 'new';
  const tierInfo = TIER_INFO[tier] || TIER_INFO.new;
  const composite = typeof record.composite === 'number' ? record.composite.toFixed(1) : '—';
  const dims = record.dimensions || {};
  const meta = record.meta || {};
  const isSkill = record.mode === 'skills';
  const isLimited = record.limited;
  const isPartial = record.mode === 'partial';

  const canonical = `https://mcpskills.io/score/${encodeURI(input)}`;
  const ogTitle = `${displayName} — ${composite}/10 ${tierInfo.label} | MCP Skills`;
  const ogDesc = meta.description
    ? `${escapeHtml(meta.description).slice(0, 155)}`
    : `${tierInfo.label} (${composite}/10). ${tierInfo.hint}`;
  const badgeUrl = `https://mcpskills.io/.netlify/functions/badge?repo=${encodeURIComponent(input)}`;

  // JSON-LD: SoftwareSourceCode + Rating + BreadcrumbList
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareSourceCode',
        'name': displayName,
        'description': meta.description || `${displayName} trust score analysis from MCP Skills.`,
        'codeRepository': record.repo ? `https://github.com/${record.repo}` : undefined,
        'programmingLanguage': 'JavaScript',
        'license': meta.license || undefined,
      },
      {
        '@type': 'Review',
        'itemReviewed': { '@type': 'SoftwareSourceCode', 'name': displayName },
        'author': { '@type': 'Organization', 'name': 'MCP Skills' },
        'reviewRating': {
          '@type': 'Rating',
          'ratingValue': composite,
          'bestRating': '10',
          'worstRating': '0',
        },
        'reviewBody': `${tierInfo.label} trust tier. ${tierInfo.hint}`,
        'datePublished': record.cachedAt,
      },
      {
        '@type': 'BreadcrumbList',
        'itemListElement': [
          { '@type': 'ListItem', 'position': 1, 'name': 'MCP Skills', 'item': 'https://mcpskills.io' },
          { '@type': 'ListItem', 'position': 2, 'name': 'Trust Scores', 'item': 'https://mcpskills.io/score' },
          { '@type': 'ListItem', 'position': 3, 'name': displayName, 'item': canonical },
        ],
      },
    ],
  };

  function dimRow(key, label) {
    const val = dims[key];
    const display = typeof val === 'number' ? val.toFixed(1) : '—';
    const pct = typeof val === 'number' ? Math.max(0, Math.min(100, val * 10)) : 0;
    let color = 'var(--red)';
    if (val >= 7) color = 'var(--green)';
    else if (val >= 5) color = 'var(--amber)';
    else if (val >= 3) color = 'var(--blue)';
    return `<div class="dim-row">
      <div class="dim-label">${label}</div>
      <div class="dim-bar-wrap"><div class="dim-bar" style="width:${pct}%;background:${color};"></div></div>
      <div class="dim-val" style="color:${color};">${display}</div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(ogTitle)}</title>
  <meta name="description" content="${ogDesc}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:title" content="${escapeHtml(ogTitle)}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="https://mcpskills.io/.netlify/functions/card?repo=${encodeURIComponent(input)}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <script defer data-domain="mcpskills.io" src="https://plausible.io/js/script.js"></script>
  <style>
    .sp-hero { padding: 48px 0 24px; border-bottom: 1px solid var(--border); }
    .sp-crumbs { color: var(--text3); font-size: 13px; margin-bottom: 16px; }
    .sp-crumbs a { color: var(--text2); }
    .sp-name { font-size: 32px; font-weight: 700; margin-bottom: 8px; word-break: break-word; }
    .sp-desc { color: var(--text2); font-size: 16px; margin-bottom: 24px; max-width: 640px; }
    .sp-score-row { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
    .sp-composite { font-size: 56px; font-weight: 700; line-height: 1; }
    .sp-out-of { color: var(--text3); font-size: 24px; font-weight: 500; }
    .sp-tier-pill { display: inline-block; padding: 8px 16px; border-radius: 999px; font-weight: 600; font-size: 14px; }
    .sp-cert-pill { display: inline-block; padding: 6px 14px; border-radius: 999px; font-weight: 600; font-size: 13px; background: rgba(217,119,6,0.15); color: #D97706; border: 1px solid rgba(217,119,6,0.3); }
    .sp-tier-hint { color: var(--text2); margin-top: 8px; font-size: 14px; }
    .sp-section { padding: 40px 0; border-bottom: 1px solid var(--border); }
    .sp-section h2 { font-size: 20px; margin-bottom: 24px; }
    .dim-row { display: grid; grid-template-columns: 120px 1fr 50px; align-items: center; gap: 16px; padding: 10px 0; }
    .dim-label { color: var(--text2); font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .dim-bar-wrap { background: var(--surface2); border-radius: 999px; height: 8px; overflow: hidden; }
    .dim-bar { height: 100%; border-radius: 999px; transition: width 0.4s; }
    .dim-val { font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
    .sp-meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; }
    .sp-meta-item { background: var(--surface); padding: 16px; border-radius: 8px; border: 1px solid var(--border); }
    .sp-meta-label { color: var(--text3); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .sp-meta-val { font-size: 18px; font-weight: 600; }
    .sp-cta { background: var(--surface); border: 1px solid var(--border); padding: 24px; border-radius: 12px; text-align: center; }
    .sp-cta a { display: inline-block; margin-top: 12px; padding: 12px 24px; background: var(--green); color: #000; border-radius: 8px; font-weight: 600; }
    .sp-cta a:hover { text-decoration: none; }
    .sp-badge-embed { background: var(--surface); border: 1px solid var(--border); padding: 16px; border-radius: 8px; font-family: var(--mono); font-size: 12px; color: var(--text2); word-break: break-all; margin-top: 16px; }
    .sp-disq { background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.3); padding: 16px; border-radius: 8px; margin-top: 16px; }
    .sp-disq-title { color: var(--red); font-weight: 600; margin-bottom: 8px; }
    .sp-footer { text-align: center; padding: 48px 0; color: var(--text3); font-size: 13px; }
    .sp-footer a { color: var(--text2); }
    @media (max-width: 600px) {
      .sp-composite { font-size: 44px; }
      .dim-row { grid-template-columns: 100px 1fr 48px; gap: 12px; }
    }
  </style>
</head>
<body>
  <div class="container" style="max-width:820px;">
    <section class="sp-hero">
      <nav class="sp-crumbs"><a href="/">MCP Skills</a> / <a href="/score">Scores</a> / ${escapeHtml(displayName)}</nav>
      <h1 class="sp-name">${escapeHtml(displayName)}</h1>
      ${meta.description ? `<p class="sp-desc">${escapeHtml(meta.description)}</p>` : ''}
      <div class="sp-score-row">
        <div>
          <span class="sp-composite" style="color:${tierInfo.color};">${composite}</span><span class="sp-out-of"> / 10</span>
        </div>
        <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
          <span class="sp-tier-pill" style="background:${tierInfo.bg}; color:${tierInfo.color};">${tierInfo.label}${isSkill ? ' • Skills Mode' : ''}${isPartial ? ' • Limited' : ''}</span>
          ${certified ? '<span class="sp-cert-pill">★ Certified Safe</span>' : ''}
        </div>
      </div>
      <p class="sp-tier-hint">${tierInfo.hint}${isLimited ? ' Scored from registry metadata only — no source-code analysis.' : ''}</p>
    </section>

    <section class="sp-section">
      <h2>Dimensions</h2>
      ${dimRow('alive', 'Alive')}
      ${dimRow('legit', 'Legit')}
      ${dimRow('solid', 'Solid')}
      ${dimRow('usable', 'Usable')}
    </section>

    <section class="sp-section">
      <h2>Repository Stats</h2>
      <div class="sp-meta-grid">
        <div class="sp-meta-item"><div class="sp-meta-label">Stars</div><div class="sp-meta-val">${formatNumber(meta.stars)}</div></div>
        <div class="sp-meta-item"><div class="sp-meta-label">Forks</div><div class="sp-meta-val">${formatNumber(meta.forks)}</div></div>
        <div class="sp-meta-item"><div class="sp-meta-label">License</div><div class="sp-meta-val">${escapeHtml(meta.license || '—')}</div></div>
        <div class="sp-meta-item"><div class="sp-meta-label">Mode</div><div class="sp-meta-val">${isSkill ? 'Skills' : (isPartial ? 'Partial' : 'Standard')}</div></div>
      </div>
      ${record.disqualifiers && record.disqualifiers.length > 0 ? `
        <div class="sp-disq">
          <div class="sp-disq-title">Disqualifiers detected</div>
          <div style="font-size:13px;color:var(--text2);">${record.disqualifiers.map(d => escapeHtml(typeof d === 'string' ? d : (d.code || d.name || ''))).join(', ')}</div>
        </div>
      ` : ''}
    </section>

    <section class="sp-section">
      <h2>Embed this badge</h2>
      <p style="color:var(--text2);margin-bottom:12px;">Add the MCP Skills trust badge to your README to show current status.</p>
      <img src="${badgeUrl}" alt="MCP Skills trust badge" style="margin-bottom:8px;">
      <div class="sp-badge-embed">[![MCP Skills](${badgeUrl})](${canonical})</div>
    </section>

    <section class="sp-section">
      <div class="sp-cta">
        <div style="font-size:18px;font-weight:600;margin-bottom:4px;">Want the full 14-signal breakdown?</div>
        <div style="color:var(--text2);font-size:14px;">Unlock safety scan findings, signal-level scores, and actionable recommendations.</div>
        <a href="/?repo=${encodeURIComponent(input)}#pricing">Get the full report →</a>
      </div>
    </section>

    <footer class="sp-footer">
      Last scored ${new Date(record.cachedAt).toISOString().slice(0, 10)} · <a href="/">mcpskills.io</a> · <a href="/methodology">Methodology</a>
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

  const input = parseInput(event.path || '');
  if (!input) {
    return {
      statusCode: 302,
      headers: { Location: '/' },
      body: '',
    };
  }

  // Cache key is lowercased for consistency with other stores
  const cacheKey = input.toLowerCase();

  // 1. Try cached page record
  let record = await lookupPageCache(cacheKey);

  // 2. On miss or expiry, score live and persist
  if (!record) {
    const token = process.env.GITHUB_TOKEN || null;
    try {
      const result = await scoreAny(input, token);
      if (result.error) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          body: renderNotFound(input),
        };
      }
      await savePageCache(cacheKey, result);
      // Auto-cert eligible repos on first page render — same policy as badge/nightly.
      await tryAutoCertify(cacheKey, result, 'score-page');
      record = {
        input,
        repo: result.repo,
        package: result.package,
        composite: result.composite,
        tier: result.tier,
        mode: result.mode,
        limited: result.limited || false,
        dimensions: result.dimensions || {},
        meta: result.meta || {},
        disqualifiers: result.disqualifiers || [],
        cachedAt: new Date().toISOString(),
      };
    } catch {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: renderNotFound(input),
      };
    }
  }

  const certified = await isCertified(cacheKey);
  const html = renderPage(record, certified);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=600, s-maxage=3600', // 10 min browser, 1h CDN
    },
    body: html,
  };
};
