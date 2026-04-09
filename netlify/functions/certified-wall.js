/**
 * GET /certified
 *
 * Public wall of every auto-certified and manually-certified repo.
 * Updates in real time as new certs are written by tryAutoCertify().
 * Each card has a "Share on X" prefilled intent URL carrying the badge,
 * repo page link, and attribution — turns auto-certs into social proof.
 *
 * Cached 1h at the CDN layer so the cert list doesn't hit blob storage
 * on every crawler hit.
 */

const { connectLambda, getStore } = require('@netlify/blobs');

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadCertifiedRepos() {
  const certs = [];
  try {
    const store = getStore('certifications');
    const { blobs } = await store.list();
    for (const b of blobs) {
      if (!b.key.startsWith('cert:')) continue;
      try {
        const raw = await store.get(b.key);
        if (!raw) continue;
        const record = JSON.parse(raw);
        if (record.status !== 'certified') continue;
        certs.push({
          repo: record.repo,
          score: record.score,
          tier: record.tier,
          certifiedAt: record.certifiedAt,
          certifiedBy: record.certifiedBy || 'manual',
        });
      } catch {}
    }
  } catch {}
  // Sort newest first
  certs.sort((a, b) => (b.certifiedAt || '').localeCompare(a.certifiedAt || ''));
  return certs;
}

function renderCard(cert) {
  const repo = cert.repo;
  const repoPage = `https://mcpskills.io/score/${encodeURI(repo)}`;
  const badge = `https://mcpskills.io/badge/${repo}`;
  const scoreStr = typeof cert.score === 'number' ? cert.score.toFixed(1) : '—';
  const certifiedDate = cert.certifiedAt ? new Date(cert.certifiedAt).toISOString().slice(0, 10) : '';
  const tweetText = `${repo} is MCP Skills Certified Safe (${scoreStr}/10) — trust-scored across 14 signals.`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(repoPage)}`;
  return `
    <div class="cw-card">
      <div class="cw-card-head">
        <a href="${repoPage}" class="cw-repo">${escapeHtml(repo)}</a>
        <span class="cw-score">${scoreStr}<span style="font-size:11px;color:var(--text3);"> / 10</span></span>
      </div>
      <div class="cw-badge-row"><img src="${badge}" alt="Certified Safe badge" loading="lazy"></div>
      <div class="cw-meta">
        <span>Certified ${certifiedDate}</span>
        <a href="${tweetUrl}" class="cw-share" target="_blank" rel="noopener">Share</a>
      </div>
    </div>`;
}

function renderPage(certs) {
  const total = certs.length;
  const title = `${total} Certified Safe Repos — MCP Skills`;
  const description = `${total} AI skills, MCP servers, and packages currently hold Certified Safe status on MCP Skills. All 14-signal trust-scored, monitored for drift, and verified to meet certification requirements.`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        'name': 'MCP Skills Certified Safe Repos',
        'numberOfItems': total,
        'itemListElement': certs.slice(0, 50).map((c, i) => ({
          '@type': 'ListItem',
          'position': i + 1,
          'url': `https://mcpskills.io/score/${encodeURI(c.repo)}`,
          'name': c.repo,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        'itemListElement': [
          { '@type': 'ListItem', 'position': 1, 'name': 'MCP Skills', 'item': 'https://mcpskills.io' },
          { '@type': 'ListItem', 'position': 2, 'name': 'Certified Safe', 'item': 'https://mcpskills.io/certified' },
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
  <link rel="canonical" href="https://mcpskills.io/certified">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://mcpskills.io/certified">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <script defer data-domain="mcpskills.io" src="https://plausible.io/js/script.js"></script>
  <style>
    .cw-hero { padding: 48px 0 24px; border-bottom: 1px solid var(--border); text-align: center; }
    .cw-crumbs { color: var(--text3); font-size: 13px; margin-bottom: 16px; text-align: left; }
    .cw-crumbs a { color: var(--text2); }
    .cw-title { font-size: 32px; font-weight: 700; margin-bottom: 8px; }
    .cw-sub { color: var(--text2); font-size: 15px; max-width: 560px; margin: 0 auto; }
    .cw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; padding: 32px 0; }
    .cw-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; transition: border-color 0.15s, transform 0.15s; }
    .cw-card:hover { border-color: #D97706; transform: translateY(-1px); }
    .cw-card-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; gap: 8px; }
    .cw-repo { font-weight: 600; font-size: 14px; color: var(--text); word-break: break-word; }
    .cw-repo:hover { color: #D97706; text-decoration: none; }
    .cw-score { font-size: 18px; font-weight: 700; color: #D97706; font-variant-numeric: tabular-nums; }
    .cw-badge-row { margin: 12px 0; }
    .cw-badge-row img { max-width: 100%; height: auto; }
    .cw-meta { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text3); padding-top: 12px; border-top: 1px solid var(--border); }
    .cw-share { color: #1d9bf0; font-weight: 500; }
    .cw-empty { text-align: center; padding: 64px 0; color: var(--text2); }
    .cw-cta { background: var(--surface); border: 1px solid var(--border); padding: 32px; border-radius: 12px; text-align: center; margin: 32px 0; }
    .cw-cta h3 { font-size: 20px; margin-bottom: 8px; }
    .cw-cta p { color: var(--text2); font-size: 14px; margin-bottom: 16px; max-width: 520px; margin-left: auto; margin-right: auto; }
    .cw-cta a { display: inline-block; padding: 12px 24px; background: var(--green); color: #000; border-radius: 8px; font-weight: 600; text-decoration: none; }
    .cw-footer { text-align: center; padding: 48px 0; color: var(--text3); font-size: 13px; }
    .cw-footer a { color: var(--text2); }
  </style>
</head>
<body>
  <div class="container" style="max-width:1100px;">
    <nav class="cw-crumbs"><a href="/">MCP Skills</a> / Certified Safe</nav>
    <section class="cw-hero">
      <h1 class="cw-title">${total} Certified Safe</h1>
      <p class="cw-sub">Repos that currently meet all certification requirements: composite score ≥ 7.0, solid dimension ≥ 5.0, 8+ signals, no disqualifiers. Re-scanned nightly — certification is automatically revoked if scores drop.</p>
    </section>

    ${certs.length > 0 ? `
      <div class="cw-grid">${certs.slice(0, 100).map(renderCard).join('')}</div>
    ` : `
      <div class="cw-empty">No certified repos yet. Check back after tonight's crawler run.</div>
    `}

    <div class="cw-cta">
      <h3>Protect your Certified status</h3>
      <p>Pro monitoring re-scans your repos daily and emails you the moment the trust score drops 0.3 or more. Catch regressions before your users do.</p>
      <a href="/#pricing">Upgrade to Pro — $12/mo</a>
    </div>

    <footer class="cw-footer">
      Updated ${new Date().toISOString().slice(0, 10)} · <a href="/methodology">Methodology</a> · <a href="/">mcpskills.io</a>
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

  const certs = await loadCertifiedRepos();
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=1800, s-maxage=3600',
      'X-Certified-Count': String(certs.length),
    },
    body: renderPage(certs),
  };
};
