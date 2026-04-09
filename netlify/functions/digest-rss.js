/**
 * GET /digest/rss.xml
 *
 * Minimal RSS 2.0 feed of the last 12 weekly digests. AI crawlers and
 * feed readers discover new digests automatically — every Sunday at
 * 18:00 UTC when weekly-digest.js writes a new blob, the next request
 * to this feed picks it up after the 6h CDN cache expires.
 */

const { connectLambda, getStore } = require('@netlify/blobs');

function xmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rfc822(iso) {
  try {
    return new Date(iso).toUTCString();
  } catch {
    return new Date().toUTCString();
  }
}

async function loadRecentDigests(limit = 12) {
  const items = [];
  try {
    const store = getStore('weekly-digests');
    const { blobs } = await store.list();
    // Filter to weekly keys only (exclude "latest" pointer) and sort desc by key.
    const weekKeys = blobs
      .map(b => b.key)
      .filter(k => /^digest:\d{4}-W\d{2}$/.test(k))
      .sort()
      .reverse()
      .slice(0, limit);
    for (const key of weekKeys) {
      try {
        const raw = await store.get(key);
        if (!raw) continue;
        items.push(JSON.parse(raw));
      } catch {}
    }
  } catch {}
  return items;
}

function renderItem(d) {
  const weekDisplay = (d.weekKey || '').replace('digest:', '');
  const url = `https://mcpskills.io/digest/${weekDisplay}`;
  const s = d.summary || {};
  const hooks = d.narrativeHooks || [];
  const descParts = [
    `${s.totalRepos || 0} repos scored`,
    `average trust ${s.avgScore ?? '—'}/10`,
    `${s.tierDistribution?.verified || 0} Verified`,
    `${s.tierDistribution?.blocked || 0} Blocked`,
  ];
  const desc = [descParts.join(' · '), ...hooks].join('. ');
  return `  <item>
    <title>Weekly Trust Digest ${xmlEscape(weekDisplay)}</title>
    <link>${xmlEscape(url)}</link>
    <guid isPermaLink="true">${xmlEscape(url)}</guid>
    <pubDate>${rfc822(d.generatedAt)}</pubDate>
    <description>${xmlEscape(desc)}</description>
  </item>`;
}

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'GET only' };
  }

  const digests = await loadRecentDigests(12);
  const lastBuildDate = digests[0]?.generatedAt ? rfc822(digests[0].generatedAt) : new Date().toUTCString();

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>MCP Skills — Weekly Trust Digest</title>
    <link>https://mcpskills.io/digest</link>
    <atom:link href="https://mcpskills.io/digest/rss.xml" rel="self" type="application/rss+xml"/>
    <description>Weekly trust-score analysis for AI skills, MCP servers, and npm packages. Movers, new discoveries, and security concerns updated every Sunday.</description>
    <language>en</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <generator>mcpskills.io</generator>
${digests.map(renderItem).join('\n')}
  </channel>
</rss>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=21600',
      'X-Item-Count': String(digests.length),
    },
    body: feed,
  };
};
