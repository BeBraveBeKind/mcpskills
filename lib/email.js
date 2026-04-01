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
};
