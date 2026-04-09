/**
 * Scheduled Function: monthly-recap
 * Runs 1st–5th of each month at 14:00 UTC (see netlify.toml).
 *
 * Sends two waves of emails:
 *   1. Pro recap — every active Pro API key holder gets a personalized
 *      30-day summary of their monitored repos.
 *   2. Lead nurture — every unconverted captured free lead gets a
 *      month-in-review with a 20% discount code for the 10-pack.
 *
 * Chunked execution: a cursor blob tracks progress so the scheduled
 * function resumes across invocations (1st–5th) and never doubles up.
 * Per-recipient markers (`recap-sent:{yearMonth}:{keyHash}`) prevent
 * re-sends even if a cron fires twice in the same window.
 *
 * Resend free tier: 100 emails/day. Spreading across 5 days = ~500 safe.
 *
 * Failure mode: fully chunked + per-recipient try/catch. A single bad
 * email or missing blob can never cascade. If the cursor is corrupt,
 * treat the whole month as fresh and start over.
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const {
  sendMonthlyRecapPro,
  sendMonthlyRecapLead,
} = require('../../lib/email');

const BUDGET_MS = 8000;
const CHUNK_PER_INVOCATION = 20; // Max emails per invocation (prevents timeout)
const DISCOUNT_CODE = 'MONTHLY20'; // Placeholder — wire to LemonSqueezy discount later

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(d = new Date()) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function loadCursor() {
  try {
    const store = getStore('recap-cursor');
    const raw = await store.get('cursor');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCursor(cursor) {
  try {
    const store = getStore('recap-cursor');
    await store.set('cursor', JSON.stringify(cursor));
  } catch {}
}

async function markSent(yearMonth, identifier) {
  // We reuse the free-leads store for per-recipient send markers since
  // it already holds the lead data and adding a 14th store feels heavy.
  // Marker keys use a distinct `recap-sent:` prefix so they don't clash.
  try {
    const store = getStore('free-leads');
    await store.set(`recap-sent:${yearMonth}:${identifier}`, JSON.stringify({
      at: new Date().toISOString(),
    }));
  } catch {}
}

async function alreadySent(yearMonth, identifier) {
  try {
    const store = getStore('free-leads');
    const raw = await store.get(`recap-sent:${yearMonth}:${identifier}`);
    return !!raw;
  } catch {
    return false;
  }
}

/**
 * Load all Pro tier API key records. We iterate the api-keys blob store
 * and filter by `tier === 'pro'`. Returns array of { keyHash, email, record }.
 */
async function loadProUsers() {
  const users = [];
  try {
    const store = getStore('api-keys');
    const { blobs } = await store.list();
    for (const b of blobs) {
      try {
        const raw = await store.get(b.key);
        if (!raw) continue;
        const record = JSON.parse(raw);
        if (record.tier === 'pro' && record.email) {
          users.push({ keyHash: b.key, email: record.email, record });
        }
      } catch {}
    }
  } catch {}
  return users;
}

/**
 * Load a user's monitored repos and compute 30-day deltas for each.
 */
async function loadProUserRecap(email) {
  const monitorsStore = getStore('monitors');
  const historyStore = getStore('score-history');
  const cacheStore = getStore('score-cache');

  let watched = [];
  try {
    const raw = await monitorsStore.get(`user:${email}`);
    if (raw) {
      const record = JSON.parse(raw);
      watched = record.repos || record.watched || [];
    }
  } catch {}

  if (watched.length === 0) return { repos: [], biggestMover: null, monthlyCertCount: 0 };

  const histDate = daysAgoIso(30);
  const rows = [];

  for (const entry of watched) {
    const repoKey = (typeof entry === 'string' ? entry : entry.repo || '').toLowerCase();
    if (!repoKey) continue;

    let current, historical;
    try {
      const raw = await cacheStore.get(repoKey);
      if (raw) current = JSON.parse(raw);
    } catch {}
    try {
      const raw = await historyStore.get(`${repoKey}:${histDate}`);
      if (raw) historical = JSON.parse(raw);
    } catch {}

    if (!current) continue;

    const delta = typeof historical?.composite === 'number' && typeof current.composite === 'number'
      ? +(current.composite - historical.composite).toFixed(2)
      : null;

    const tierChange = historical?.tier && current.tier && historical.tier !== current.tier
      ? `${historical.tier} → ${current.tier}`
      : null;

    rows.push({
      repo: repoKey,
      current: current.composite,
      previous: historical?.composite ?? null,
      delta,
      tierChange,
    });
  }

  // Biggest mover by abs delta
  const withDelta = rows.filter(r => typeof r.delta === 'number');
  withDelta.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const biggestMover = withDelta[0]
    ? { repo: withDelta[0].repo, delta: withDelta[0].delta, direction: withDelta[0].delta > 0 ? 'up' : 'down' }
    : null;

  return { repos: rows, biggestMover, monthlyCertCount: 0 };
}

/**
 * Load all unconverted free leads. Filters out the `recap-sent:` marker
 * keys that share the same blob store.
 */
async function loadUnconvertedLeads() {
  const leads = [];
  try {
    const store = getStore('free-leads');
    const { blobs } = await store.list();
    for (const b of blobs) {
      if (!b.key.startsWith('lead:')) continue;
      try {
        const raw = await store.get(b.key);
        if (!raw) continue;
        const record = JSON.parse(raw);
        if (record.converted) continue;
        if (!record.email) continue;
        leads.push(record);
      } catch {}
    }
  } catch {}
  return leads;
}

async function loadLatestDigestHeadlines() {
  try {
    const store = getStore('weekly-digests');
    const raw = await store.get('latest');
    if (!raw) return [];
    const digest = JSON.parse(raw);
    return digest.narrativeHooks || [];
  } catch {
    return [];
  }
}

exports.handler = async (event) => {
  connectLambda(event);

  const startTime = Date.now();
  const now = new Date();
  const currentMonth = monthKey(now);
  const label = monthLabel(now);

  const stats = {
    startedAt: now.toISOString(),
    yearMonth: currentMonth,
    proSent: 0,
    leadSent: 0,
    proSkipped: 0,
    leadSkipped: 0,
    errors: 0,
  };

  // Load cursor — if it's from a previous month, reset it
  let cursor = await loadCursor();
  if (!cursor || cursor.yearMonth !== currentMonth) {
    cursor = { yearMonth: currentMonth, phase: 'pro', index: 0, startedAt: now.toISOString() };
  }

  // --- Phase 1: Pro recap ---
  if (cursor.phase === 'pro') {
    const proUsers = await loadProUsers();
    let processed = 0;

    for (let i = cursor.index; i < proUsers.length; i++) {
      if (Date.now() - startTime > BUDGET_MS || processed >= CHUNK_PER_INVOCATION) {
        cursor.index = i;
        await saveCursor(cursor);
        return {
          statusCode: 200,
          body: JSON.stringify({ ...stats, cursor, chunked: true }),
        };
      }

      const user = proUsers[i];
      const markerId = `pro:${user.keyHash.slice(0, 16)}`;
      if (await alreadySent(currentMonth, markerId)) {
        stats.proSkipped++;
        processed++;
        continue;
      }

      try {
        const recap = await loadProUserRecap(user.email);
        const result = await sendMonthlyRecapPro({
          email: user.email,
          repos: recap.repos,
          biggestMover: recap.biggestMover,
          monthlyCertCount: recap.monthlyCertCount,
          monthLabel: label,
        });
        if (result?.sent) {
          stats.proSent++;
          await markSent(currentMonth, markerId);
        } else {
          stats.errors++;
        }
      } catch (err) {
        console.error(`Pro recap failed for ${user.email}:`, err.message);
        stats.errors++;
      }
      processed++;
    }

    // Pro phase done — transition to lead phase
    cursor.phase = 'lead';
    cursor.index = 0;
    await saveCursor(cursor);
  }

  // --- Phase 2: Lead nurture ---
  if (cursor.phase === 'lead') {
    const leads = await loadUnconvertedLeads();
    const headlines = await loadLatestDigestHeadlines();
    let processed = 0;

    for (let i = cursor.index; i < leads.length; i++) {
      if (Date.now() - startTime > BUDGET_MS || processed >= CHUNK_PER_INVOCATION) {
        cursor.index = i;
        await saveCursor(cursor);
        return {
          statusCode: 200,
          body: JSON.stringify({ ...stats, cursor, chunked: true }),
        };
      }

      const lead = leads[i];
      const markerId = `lead:${lead.email.toLowerCase()}`;
      if (await alreadySent(currentMonth, markerId)) {
        stats.leadSkipped++;
        processed++;
        continue;
      }

      try {
        const result = await sendMonthlyRecapLead({
          email: lead.email,
          headlines,
          discountCode: DISCOUNT_CODE,
          monthLabel: label,
        });
        if (result?.sent) {
          stats.leadSent++;
          await markSent(currentMonth, markerId);
        } else {
          stats.errors++;
        }
      } catch (err) {
        console.error(`Lead recap failed for ${lead.email}:`, err.message);
        stats.errors++;
      }
      processed++;
    }

    // Lead phase done — clear cursor for next month
    try {
      const store = getStore('recap-cursor');
      await store.delete('cursor');
    } catch {}
  }

  stats.completedAt = new Date().toISOString();
  stats.durationMs = Date.now() - startTime;
  return {
    statusCode: 200,
    body: JSON.stringify({ ...stats, cursor: null, done: true }, null, 2),
  };
};
