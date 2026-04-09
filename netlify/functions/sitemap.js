/**
 * GET /sitemap.xml
 *
 * Dynamic sitemap combining static pages with every scored repo in the
 * Netlify Blobs score-cache store. Every crawler discovery and badge
 * auto-discovery flows into this sitemap automatically — compound SEO
 * without manual curation.
 *
 * Cached 6h at the CDN layer so we don't hit Blobs on every Googlebot crawl.
 */

const { connectLambda, getStore } = require('@netlify/blobs');

const STATIC_PAGES = [
  { loc: 'https://mcpskills.io/',                                changefreq: 'weekly',  priority: '1.0' },
  { loc: 'https://mcpskills.io/certified',                        changefreq: 'daily',   priority: '0.9' },
  { loc: 'https://mcpskills.io/trending',                         changefreq: 'daily',   priority: '0.9' },
  { loc: 'https://mcpskills.io/roadmap',                          changefreq: 'monthly', priority: '0.6' },
  { loc: 'https://mcpskills.io/certify',                          changefreq: 'monthly', priority: '0.6' },
  { loc: 'https://mcpskills.io/blog/state-of-ai-skill-security',  changefreq: 'monthly', priority: '0.8' },
  { loc: 'https://mcpskills.io/blog/clawhavoc-missing-trust-layer', changefreq: 'monthly', priority: '0.8' },
  { loc: 'https://mcpskills.io/blog/how-to-check-ai-skill-safe',  changefreq: 'monthly', priority: '0.8' },
  { loc: 'https://mcpskills.io/blog/score-without-github-repo',   changefreq: 'monthly', priority: '0.8' },
  { loc: 'https://mcpskills.io/privacy',                          changefreq: 'yearly',  priority: '0.3' },
  { loc: 'https://mcpskills.io/terms',                            changefreq: 'yearly',  priority: '0.3' },
];

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function renderUrl({ loc, lastmod, changefreq, priority }) {
  const parts = [`    <loc>${xmlEscape(loc)}</loc>`];
  if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
  if (changefreq) parts.push(`    <changefreq>${changefreq}</changefreq>`);
  if (priority) parts.push(`    <priority>${priority}</priority>`);
  return `  <url>\n${parts.join('\n')}\n  </url>`;
}

async function loadScoredEntries() {
  const entries = [];
  try {
    const store = getStore('score-cache');
    const { blobs } = await store.list();
    for (const b of blobs) {
      // Key is owner/repo or npm:packagename — all already lowercased at write time
      entries.push(b.key);
    }
  } catch {}
  return entries;
}

async function loadDigestWeeks() {
  const weeks = [];
  try {
    const store = getStore('weekly-digests');
    const { blobs } = await store.list();
    for (const b of blobs) {
      // Only include week-keyed entries (exclude "latest" pointer)
      if (/^digest:\d{4}-W\d{2}$/.test(b.key)) {
        weeks.push(b.key.replace('digest:', ''));
      }
    }
  } catch {}
  return weeks;
}

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'GET only' };
  }

  const [scoredEntries, digestWeeks] = await Promise.all([
    loadScoredEntries(),
    loadDigestWeeks(),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  const urls = [
    ...STATIC_PAGES.map(renderUrl),
    // Weekly digest landing pages (content flywheel)
    renderUrl({
      loc: 'https://mcpskills.io/digest',
      lastmod: today,
      changefreq: 'weekly',
      priority: '0.9',
    }),
    ...digestWeeks.map(week => renderUrl({
      loc: `https://mcpskills.io/digest/${encodeURI(week)}`,
      lastmod: today,
      changefreq: 'monthly',
      priority: '0.8',
    })),
    // Per-repo trust score pages (compound over time)
    ...scoredEntries.map(key => renderUrl({
      loc: `https://mcpskills.io/score/${encodeURI(key)}`,
      lastmod: today,
      changefreq: 'weekly',
      priority: '0.7',
    })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=21600', // 1h browser, 6h CDN
      'X-Scored-URLs': String(scoredEntries.length),
      'X-Digest-Weeks': String(digestWeeks.length),
    },
    body: xml,
  };
};
