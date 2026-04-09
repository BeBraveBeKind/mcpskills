/**
 * lib/email.js — Email via Resend REST API
 *
 * Simple fetch-based email sender. No SDK needed.
 * Free tier: 100 emails/day.
 * From: alerts@mcpskills.io (requires DNS verification)
 */

const RESEND_API = 'https://api.resend.com/emails';
const FROM = 'MCP Skills <alerts@mcpskills.io>';

/** Escape user-controlled values before injecting into HTML emails */
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — email not sent:', subject);
    return { sent: false, reason: 'no_api_key' };
  }

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', res.status, err);
      return { sent: false, reason: `resend_error_${res.status}` };
    }

    const data = await res.json();
    console.log('Email sent:', data.id);
    return { sent: true, id: data.id };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

// --- Templates ---

async function sendScoreDropAlert({ email, repo, oldScore, newScore, oldTier, newTier }) {
  const delta = Math.round((newScore - oldScore) * 100) / 100;
  const arrow = delta > 0 ? '↑' : '↓';
  const color = delta > 0 ? '#16a34a' : '#dc2626';
  const tierChanged = oldTier !== newTier;

  return sendEmail({
    to: email,
    subject: `⚠️ Trust score change: ${repo} (${oldScore} → ${newScore})`,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;font-size:18px;">Trust Score Alert</h2>
        <div style="background:#f8f9fa;border:1px solid #e2e4e6;border-radius:8px;padding:20px;margin-bottom:16px;">
          <div style="font-weight:600;font-size:16px;margin-bottom:12px;">${esc(repo)}</div>
          <div style="font-size:28px;font-weight:700;color:${color};">
            ${oldScore} → ${newScore} <span style="font-size:16px;">(${arrow}${Math.abs(delta)})</span>
          </div>
          ${tierChanged ? `<div style="margin-top:8px;font-size:14px;color:#666;">Tier: ${oldTier} → ${newTier}</div>` : ''}
        </div>
        <a href="https://mcpskills.io/?repo=${encodeURIComponent(repo)}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;font-weight:500;">View Full Report</a>
        <p style="margin-top:24px;font-size:12px;color:#999;">You're receiving this because you're monitoring ${esc(repo)} on MCP Skills. <a href="https://mcpskills.io" style="color:#999;">Manage alerts</a></p>
      </div>
    `,
  });
}

async function sendApiKeyDelivery({ email, apiKey, credits, type }) {
  const isUnlimited = credits === null;
  return sendEmail({
    to: email,
    subject: `🔑 Your MCP Skills API key is ready`,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;font-size:18px;">Your API Key</h2>
        <p>Thank you for your purchase! Here's your API key:</p>
        <div style="background:#1a1a2e;color:#00ff88;padding:16px;border-radius:8px;font-family:monospace;font-size:14px;word-break:break-all;margin:16px 0;">
          ${esc(apiKey)}
        </div>
        <div style="background:#f8f9fa;border:1px solid #e2e4e6;border-radius:8px;padding:16px;margin-bottom:16px;">
          <div><strong>Plan:</strong> ${type === 'pro' ? 'Pro ($12/mo)' : '10-Pack ($29)'}</div>
          <div><strong>Credits:</strong> ${isUnlimited ? 'Unlimited' : credits}</div>
          ${type === 'pro' ? '<div><strong>Monitoring:</strong> Up to 10 repos</div>' : ''}
        </div>
        <h3 style="font-size:15px;">How to use</h3>
        <p><strong>Web:</strong> Paste into the API Key Settings panel at <a href="https://mcpskills.io">mcpskills.io</a></p>
        <p><strong>API:</strong> Pass as <code>X-API-Key</code> header</p>
        <p><strong>MCP Server:</strong> Set <code>MCPSKILLS_API_KEY</code> environment variable</p>
        <p style="margin-top:24px;font-size:12px;color:#999;">Keep this key safe — it's your access to full reports. If lost, contact <a href="mailto:hello@mcpskills.io" style="color:#999;">hello@mcpskills.io</a></p>
      </div>
    `,
  });
}

/**
 * Sent automatically when a repo earns auto-certification (score >= 7,
 * solid >= 5, 8+ signals, no disqualifiers, no existing cert record).
 * Triggered from lib/auto-certify.js `onCertified()` hook after the cert
 * blob write. Fire-and-forget — cert persists even if email send fails.
 *
 * Goal: turn the auto-cert into owner advocacy. The markdown snippet
 * makes it one-copy-paste to embed the gold badge in their README; the
 * share-on-X link turns that into social proof.
 */
async function sendAutoCertEmail({ email, repo, score }) {
  const scoreStr = typeof score === 'number' ? score.toFixed(1) : String(score || '—');
  const badgeUrl = `https://mcpskills.io/badge/${repo}`;
  const repoPageUrl = `https://mcpskills.io/score/${encodeURIComponent(repo)}`;
  const markdownSnippet = `[![MCP Skills Certified Safe](${badgeUrl})](${repoPageUrl})`;
  const tweetText = `My repo ${repo} just earned the MCP Skills Certified Safe badge (${scoreStr}/10) — trust-scored across 14 signals.`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(repoPageUrl)}`;

  return sendEmail({
    to: email,
    subject: `🏅 ${repo} is now MCP Skills Certified Safe (${scoreStr}/10)`,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;font-size:20px;">Congrats — your repo is Certified Safe</h2>
        <p style="color:#555;">Our automated trust scanner just evaluated <strong>${esc(repo)}</strong> and it passed every certification requirement: composite score ${scoreStr}/10, strong security posture, 8+ signals, no disqualifiers.</p>

        <div style="background:#fffbea;border:1px solid #f5d76e;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
          <img src="${badgeUrl}" alt="MCP Skills Certified Safe" style="margin-bottom:8px;">
          <div style="font-size:13px;color:#8a6d1a;">Your gold badge is live and refreshes automatically.</div>
        </div>

        <h3 style="font-size:15px;margin-top:24px;">Embed the badge in your README</h3>
        <p style="color:#555;font-size:14px;">Copy this line into your README.md:</p>
        <div style="background:#1a1a2e;color:#00ff88;padding:12px;border-radius:6px;font-family:monospace;font-size:12px;word-break:break-all;margin:8px 0;">
          ${esc(markdownSnippet)}
        </div>

        <h3 style="font-size:15px;margin-top:24px;">Share it</h3>
        <p style="color:#555;font-size:14px;">Let your users know your repo earned verified status:</p>
        <a href="${tweetUrl}" style="display:inline-block;padding:10px 20px;background:#1d9bf0;color:white;text-decoration:none;border-radius:6px;font-weight:500;margin-right:8px;">Share on X</a>
        <a href="${repoPageUrl}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;font-weight:500;">View public page</a>

        <div style="margin-top:32px;padding:16px;background:#f8f9fa;border-left:3px solid #2563eb;border-radius:4px;">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Protect your Certified status</div>
          <div style="font-size:13px;color:#666;">Pro monitoring re-scans your repo daily and emails you the moment the trust score drops 0.3 or more. $12/mo, cancel anytime.</div>
          <a href="https://mcpskills.io/#pricing" style="display:inline-block;margin-top:8px;font-size:13px;color:#2563eb;text-decoration:none;font-weight:500;">Upgrade to Pro →</a>
        </div>

        <p style="margin-top:32px;font-size:12px;color:#999;">
          You're receiving this because ${esc(repo)} is publicly listed on GitHub and earned auto-certification from MCP Skills. We trust-score AI skills, MCP servers, and npm packages at <a href="https://mcpskills.io" style="color:#999;">mcpskills.io</a>. No further emails unless your cert status changes or you opt into monitoring.
        </p>
      </div>
    `,
  });
}

/**
 * Sent when a rate-limited free user drops their email in exchange for
 * one free full report. This is the "gift" side of the lead-capture loop:
 * the user gets real $9-tier value, we get an opted-in lead for nurture.
 *
 * The HTML report is a compact version of the full-mode scoring output —
 * we include dimensions, signal-level scores, and top safety findings.
 * Enough to prove the $9 value without fully replacing it for repeat use.
 */
async function sendFreeSampleReport({ email, repo, result }) {
  const composite = typeof result?.composite === 'number' ? result.composite.toFixed(1) : '—';
  const tier = result?.tier || 'unknown';
  const dims = result?.dimensions || {};
  const signals = result?.signals || {};
  const mode = result?.mode || 'standard';
  const isSkill = mode === 'skills';
  const meta = result?.meta || {};

  const dimRow = (name, label) => {
    const val = dims[name];
    if (typeof val !== 'number') return '';
    const pct = Math.max(0, Math.min(100, val * 10));
    const color = val >= 7 ? '#16a34a' : val >= 5 ? '#ca8a04' : '#dc2626';
    return `<tr>
      <td style="padding:6px 0;color:#555;font-size:13px;">${label}</td>
      <td style="padding:6px 0;text-align:right;font-weight:600;color:${color};">${val.toFixed(1)}</td>
      <td style="padding:6px 0 6px 12px;width:100px;"><div style="background:#eee;border-radius:999px;height:6px;overflow:hidden;"><div style="background:${color};width:${pct}%;height:6px;"></div></div></td>
    </tr>`;
  };

  const signalRows = Object.entries(signals)
    .filter(([, v]) => typeof v === 'number')
    .slice(0, 14)
    .map(([k, v]) => {
      const label = k.replace(/_/g, ' ');
      const color = v >= 7 ? '#16a34a' : v >= 5 ? '#ca8a04' : '#dc2626';
      return `<tr><td style="padding:4px 0;color:#555;font-size:12px;text-transform:capitalize;">${esc(label)}</td><td style="padding:4px 0;text-align:right;font-weight:600;color:${color};font-size:12px;font-variant-numeric:tabular-nums;">${v.toFixed(1)}</td></tr>`;
    }).join('');

  const safetyFindings = result?.safetyFindings || [];
  const safetySection = isSkill && safetyFindings.length > 0 ? `
    <h3 style="font-size:14px;margin:20px 0 8px;">Safety scan findings</h3>
    <ul style="padding-left:20px;color:#555;font-size:13px;">
      ${safetyFindings.slice(0, 5).map(f => `<li>${esc(typeof f === 'string' ? f : f.description || f.pattern || 'Finding')}</li>`).join('')}
    </ul>
  ` : '';

  return sendEmail({
    to: email,
    subject: `Your free report: ${repo} (${composite}/10)`,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 8px;font-size:20px;">Here's your free trust report</h2>
        <p style="color:#555;margin-bottom:16px;">Full 14-signal breakdown for <strong>${esc(repo)}</strong> — on the house.</p>

        <div style="background:#f8f9fa;border:1px solid #e2e4e6;border-radius:8px;padding:20px;margin-bottom:20px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;">
            <div style="font-weight:600;font-size:15px;word-break:break-word;">${esc(repo)}</div>
            <div style="font-size:28px;font-weight:700;color:#2563eb;">${composite}<span style="font-size:14px;color:#999;"> / 10</span></div>
          </div>
          <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">${esc(tier)}${isSkill ? ' · Skills Mode' : ''}</div>
          ${meta.description ? `<div style="margin-top:12px;color:#666;font-size:13px;">${esc(meta.description).slice(0, 200)}</div>` : ''}
        </div>

        <h3 style="font-size:14px;margin:20px 0 8px;">Dimensions</h3>
        <table style="width:100%;border-collapse:collapse;">
          ${dimRow('alive', 'Alive')}
          ${dimRow('legit', 'Legit')}
          ${dimRow('solid', 'Solid')}
          ${dimRow('usable', 'Usable')}
        </table>

        ${signalRows ? `
          <h3 style="font-size:14px;margin:20px 0 8px;">Signal-level scores</h3>
          <table style="width:100%;border-collapse:collapse;">${signalRows}</table>
        ` : ''}

        ${safetySection}

        <div style="margin-top:24px;padding:16px;background:#fffbea;border-left:3px solid #f5d76e;border-radius:4px;">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Want unlimited reports?</div>
          <div style="font-size:13px;color:#666;">This one's on us. For unlimited scans, batch API, and monitoring, upgrade to <a href="https://mcpskills.io/#pricing" style="color:#2563eb;">Pro at $12/mo</a> or grab the <a href="https://mcpskills.io/#pricing" style="color:#2563eb;">10-pack for $29</a>.</div>
        </div>

        <p style="margin-top:32px;font-size:12px;color:#999;">
          You requested this report at <a href="https://mcpskills.io" style="color:#999;">mcpskills.io</a>. We'll send you a monthly recap of interesting trust movements (unsubscribe anytime). No spam.
        </p>
      </div>
    `,
  });
}

/**
 * Monthly recap for Pro subscribers. Shows their monitored repos, any
 * score changes, and tier shifts over the last 30 days. Proves recurring
 * value so they renew rather than churn.
 *
 * @param {string} email
 * @param {Array} repos - [{ repo, current, previous, delta, tierChange, certifiedNow }]
 * @param {object} biggestMover - { repo, delta, direction } or null
 * @param {number} monthlyCertCount - how many new certs landed in their watched list
 */
async function sendMonthlyRecapPro({ email, repos, biggestMover, monthlyCertCount, monthLabel }) {
  const hasData = Array.isArray(repos) && repos.length > 0;
  const rowsHtml = hasData ? repos.slice(0, 10).map(r => {
    const deltaStr = typeof r.delta === 'number' ? (r.delta > 0 ? `+${r.delta.toFixed(2)}` : r.delta.toFixed(2)) : '—';
    const color = (r.delta || 0) > 0 ? '#16a34a' : (r.delta || 0) < 0 ? '#dc2626' : '#888';
    const tierNote = r.tierChange ? ` (${r.tierChange})` : '';
    return `<tr>
      <td style="padding:6px 0;font-size:13px;"><a href="https://mcpskills.io/score/${encodeURIComponent(r.repo)}" style="color:#2563eb;text-decoration:none;">${esc(r.repo)}</a></td>
      <td style="padding:6px 0;text-align:right;font-size:13px;color:#666;">${r.current?.toFixed?.(1) || '—'}</td>
      <td style="padding:6px 0;text-align:right;font-size:13px;color:${color};font-weight:600;">${deltaStr}${esc(tierNote)}</td>
    </tr>`;
  }).join('') : '';

  const moverLine = biggestMover
    ? `Biggest mover: <strong>${esc(biggestMover.repo)}</strong> moved ${biggestMover.direction === 'up' ? '↑' : '↓'} ${Math.abs(biggestMover.delta).toFixed(2)} points.`
    : 'No significant movements — all your repos held steady this month.';

  return sendEmail({
    to: email,
    subject: `Your monthly trust recap — ${monthLabel || ''}`.trim(),
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 8px;font-size:20px;">Monthly trust recap</h2>
        <p style="color:#555;margin-bottom:16px;">${hasData ? `Here's how your ${repos.length} monitored repo${repos.length === 1 ? '' : 's'} moved over the last 30 days.` : 'No repos currently in monitoring. Add up to 10 with your Pro plan.'}</p>

        ${hasData ? `
          <p style="color:#555;font-size:14px;margin-bottom:16px;">${moverLine}</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <thead>
              <tr>
                <th style="text-align:left;padding:8px 0;border-bottom:1px solid #e2e4e6;font-size:11px;color:#888;text-transform:uppercase;">Repo</th>
                <th style="text-align:right;padding:8px 0;border-bottom:1px solid #e2e4e6;font-size:11px;color:#888;text-transform:uppercase;">Now</th>
                <th style="text-align:right;padding:8px 0;border-bottom:1px solid #e2e4e6;font-size:11px;color:#888;text-transform:uppercase;">Δ 30d</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        ` : ''}

        ${monthlyCertCount > 0 ? `
          <div style="background:#fffbea;border:1px solid #f5d76e;border-radius:6px;padding:16px;margin-bottom:16px;">
            <strong style="font-size:14px;">${monthlyCertCount} new Certified Safe repo${monthlyCertCount === 1 ? '' : 's'}</strong>
            <p style="font-size:13px;color:#666;margin:4px 0 0;">Explore the full list at <a href="https://mcpskills.io/certified" style="color:#2563eb;">mcpskills.io/certified</a>.</p>
          </div>
        ` : ''}

        <div style="background:#f8f9fa;border:1px solid #e2e4e6;border-radius:6px;padding:16px;font-size:13px;color:#666;">
          <strong style="font-size:14px;color:#333;">Your Pro plan</strong><br>
          Unlimited scans · daily monitoring · batch API · trending endpoint · 1000 agent calls/day
        </div>

        <p style="margin-top:32px;font-size:12px;color:#999;">
          You're receiving this because you have an active Pro subscription at MCP Skills. <a href="https://mcpskills.io" style="color:#999;">Manage your account</a>
        </p>
      </div>
    `,
  });
}

/**
 * Monthly nurture for captured free leads. Shows interesting movements
 * from the weekly digest, includes a 20% off discount code for the 10-pack.
 * Goal: convert unconverted leads into paying customers.
 */
async function sendMonthlyRecapLead({ email, headlines, discountCode, monthLabel }) {
  const headlinesHtml = Array.isArray(headlines) && headlines.length > 0
    ? headlines.slice(0, 5).map(h => `<li style="padding:6px 0;color:#555;font-size:14px;">${esc(h)}</li>`).join('')
    : '';

  return sendEmail({
    to: email,
    subject: `This month in AI skill trust — ${monthLabel || ''}`.trim(),
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 8px;font-size:20px;">This month in AI skill trust</h2>
        <p style="color:#555;margin-bottom:20px;">A quick monthly digest from MCP Skills — what moved, what's trending, and what to watch.</p>

        ${headlinesHtml ? `
          <h3 style="font-size:14px;margin:16px 0 8px;color:#333;">Headlines</h3>
          <ul style="padding-left:20px;margin:0 0 20px;list-style:disc;">${headlinesHtml}</ul>
        ` : ''}

        <div style="background:#f0f9ff;border-left:4px solid #2563eb;padding:16px;border-radius:4px;margin:16px 0;">
          <strong style="font-size:15px;color:#1e40af;">20% off the 10-pack — your discount code</strong>
          <p style="font-size:13px;color:#666;margin:8px 0 12px;">Ten full 14-signal reports for $23 instead of $29. Use the code below at checkout.</p>
          <div style="background:#1a1a2e;color:#00ff88;padding:12px;border-radius:6px;font-family:monospace;font-size:14px;text-align:center;letter-spacing:1px;">${esc(discountCode || 'MONTHLY20')}</div>
          <a href="https://mcpskills.io/#pricing" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;font-weight:500;font-size:14px;">Grab the 10-pack →</a>
        </div>

        <div style="margin-top:24px;padding:16px;background:#f8f9fa;border:1px solid #e2e4e6;border-radius:6px;">
          <strong style="font-size:14px;">Explore what's new</strong>
          <p style="font-size:13px;color:#666;margin:6px 0;">
            → <a href="https://mcpskills.io/digest" style="color:#2563eb;">This week's trust digest</a><br>
            → <a href="https://mcpskills.io/certified" style="color:#2563eb;">Certified Safe repos</a><br>
            → <a href="https://mcpskills.io/trending" style="color:#2563eb;">Trending trust movers</a>
          </p>
        </div>

        <p style="margin-top:32px;font-size:12px;color:#999;">
          You received this because you claimed a free report at MCP Skills. One email a month, unsubscribe by replying with "remove".
        </p>
      </div>
    `,
  });
}

async function sendCertificationUpdate({ email, repo, status, reason }) {
  const isApproved = status === 'approved';
  return sendEmail({
    to: email,
    subject: `${isApproved ? '🏅' : '⚠️'} Certification ${status}: ${repo}`,
    html: `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;font-size:18px;">Certification ${status.charAt(0).toUpperCase() + status.slice(1)}</h2>
        <div style="background:#f8f9fa;border:1px solid #e2e4e6;border-radius:8px;padding:20px;margin-bottom:16px;">
          <div style="font-weight:600;font-size:16px;margin-bottom:8px;">${esc(repo)}</div>
          <div style="font-size:14px;color:${isApproved ? '#16a34a' : '#dc2626'};">
            ${isApproved ? 'Certified Safe' : esc(status)}
          </div>
          ${reason ? `<div style="margin-top:8px;font-size:13px;color:#666;">${esc(reason)}</div>` : ''}
        </div>
        ${isApproved ? `
          <p>Your repo is now Certified Safe! The gold badge is live:</p>
          <p><code>![Certified](https://mcpskills.io/badge/${repo})</code></p>
        ` : `
          <p>You can re-apply once the issues are resolved.</p>
        `}
        <a href="https://mcpskills.io/?repo=${encodeURIComponent(repo)}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;font-weight:500;">View Report</a>
        <p style="margin-top:24px;font-size:12px;color:#999;">MCP Skills Certification Program · <a href="https://mcpskills.io" style="color:#999;">mcpskills.io</a></p>
      </div>
    `,
  });
}

module.exports = {
  sendEmail,
  sendScoreDropAlert,
  sendApiKeyDelivery,
  sendCertificationUpdate,
  sendAutoCertEmail,
  sendFreeSampleReport,
  sendMonthlyRecapPro,
  sendMonthlyRecapLead,
};
