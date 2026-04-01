/**
 * POST /.netlify/functions/certify
 * Certified Safe Badge Program — application, review, and listing.
 *
 * Actions:
 *   { action: "apply", repo: "owner/repo", email: "maintainer@..." }
 *   { action: "status", repo: "owner/repo" }
 *   { action: "review", repo: "owner/repo", decision: "approve"|"reject", notes: "...", key: ADMIN_KEY }
 *   { action: "list" } — all certified repos (public)
 *
 * Requirements for certification:
 *   - Score >= 7.0
 *   - dimensions.solid >= 5.0
 *   - No disqualifiers
 *   - >= 8 sufficient signals
 *   - Not archived
 *
 * Storage: Netlify Blobs ("certifications" store)
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreRepo } = require('../../lib/scorer');
const { sendCertificationUpdate } = require('../../lib/email');

const REQUIREMENTS = {
  minScore: 7.0,
  minSolid: 5.0,
  minSignals: 8,
};

function certificationsStore() {
  return getStore('certifications');
}

function checkEligibility(result) {
  const reasons = [];

  if (result.composite < REQUIREMENTS.minScore) {
    reasons.push(`Score ${result.composite} < ${REQUIREMENTS.minScore} required`);
  }
  if (result.dimensions?.solid != null && result.dimensions.solid < REQUIREMENTS.minSolid) {
    reasons.push(`Solid dimension ${result.dimensions.solid} < ${REQUIREMENTS.minSolid} required`);
  }
  if (result.disqualifiers?.length > 0) {
    reasons.push(`Disqualifiers present: ${result.disqualifiers.join(', ')}`);
  }
  const signalCount = result.signals ? Object.values(result.signals).filter(v => v != null).length : 0;
  if (signalCount < REQUIREMENTS.minSignals) {
    reasons.push(`Only ${signalCount} signals (need ${REQUIREMENTS.minSignals}+)`);
  }

  return { eligible: reasons.length === 0, reasons };
}

exports.handler = async (event) => {
  connectLambda(event);

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://mcpskills.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action } = body;
  const store = certificationsStore();

  switch (action) {
    case 'apply': {
      const { repo, email } = body;
      const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
      if (!repo || !REPO_RE.test(repo)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid repo format. Use owner/repo.' }) };
      }
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email || !EMAIL_RE.test(email)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email' }) };
      }

      // Rate limit certification applications by IP (#5)
      const { checkRateLimit, hashIP } = require('../../lib/auth');
      const ipHash = hashIP(event);
      const rateCheck = await checkRateLimit(ipHash, 'human');
      if (!rateCheck.allowed) {
        return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many applications. Try again later.' }) };
      }

      // Check if already certified or pending
      try {
        const existing = await store.get(`cert:${repo}`);
        if (existing) {
          const record = JSON.parse(existing);
          if (record.status === 'certified') {
            return { statusCode: 200, headers, body: JSON.stringify({ status: 'already_certified', repo }) };
          }
          if (record.status === 'pending') {
            return { statusCode: 200, headers, body: JSON.stringify({ status: 'already_pending', repo }) };
          }
        }
      } catch {}

      // Score the repo
      const token = process.env.GITHUB_TOKEN || null;
      const [owner, repoName] = repo.split('/');
      let result;
      try {
        result = await scoreRepo(owner, repoName, token);
        if (result.error) {
          return { statusCode: 404, headers, body: JSON.stringify({ error: result.error }) };
        }
      } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to score repo' }) };
      }

      // Check eligibility
      const { eligible, reasons } = checkEligibility(result);
      if (!eligible) {
        return {
          statusCode: 200, headers,
          body: JSON.stringify({
            status: 'ineligible',
            repo,
            score: result.composite,
            reasons,
          }),
        };
      }

      // Create application
      const record = {
        repo, email,
        status: 'pending',
        score: result.composite,
        tier: result.tier,
        solid: result.dimensions?.solid,
        appliedAt: new Date().toISOString(),
        log: [
          { action: 'applied', at: new Date().toISOString(), by: email, score: result.composite },
        ],
      };

      await store.set(`cert:${repo}`, JSON.stringify(record));

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          status: 'pending',
          repo,
          score: result.composite,
          message: 'Application submitted. An admin will review shortly.',
        }),
      };
    }

    case 'status': {
      const { repo } = body;
      if (!repo || !repo.includes('/')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid repo format' }) };
      }

      try {
        const raw = await store.get(`cert:${repo}`);
        if (!raw) {
          return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_applied', repo }) };
        }
        const record = JSON.parse(raw);
        return {
          statusCode: 200, headers,
          body: JSON.stringify({
            repo,
            status: record.status,
            score: record.score,
            certifiedAt: record.certifiedAt || null,
            revokedAt: record.revokedAt || null,
            log: record.log,
          }),
        };
      } catch {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'not_applied', repo }) };
      }
    }

    case 'review': {
      const { repo, decision, notes, key } = body;

      // Admin auth — timing-safe comparison (#14)
      const adminKey = process.env.ADMIN_KEY;
      const crypto = require('crypto');
      if (!adminKey || !key || key.length !== adminKey.length
          || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(adminKey))) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Invalid admin key' }) };
      }

      const REPO_RE_ADMIN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
      if (!repo || !REPO_RE_ADMIN.test(repo)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid repo format' }) };
      }
      if (!decision || !['approve', 'reject', 'revoke'].includes(decision)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Decision must be approve, reject, or revoke' }) };
      }
      if (!notes || notes.trim().length < 5) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Notes required (min 5 chars). No empty approvals.' }) };
      }

      let raw;
      try {
        raw = await store.get(`cert:${repo}`);
      } catch {}

      if (!raw) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'No application found for this repo' }) };
      }

      const record = JSON.parse(raw);

      if (decision === 'approve') {
        record.status = 'certified';
        record.certifiedAt = new Date().toISOString();
        record.log.push({
          action: 'approved', at: new Date().toISOString(), by: 'admin', notes,
        });

        // Email maintainer
        if (record.email) {
          await sendCertificationUpdate({ email: record.email, repo, status: 'approved', reason: notes });
        }

      } else if (decision === 'reject') {
        record.status = 'rejected';
        record.rejectedAt = new Date().toISOString();
        record.log.push({
          action: 'rejected', at: new Date().toISOString(), by: 'admin', notes,
        });

        if (record.email) {
          await sendCertificationUpdate({ email: record.email, repo, status: 'rejected', reason: notes });
        }

      } else if (decision === 'revoke') {
        record.status = 'revoked';
        record.revokedAt = new Date().toISOString();
        record.log.push({
          action: 'revoked', at: new Date().toISOString(), by: 'admin', notes,
        });

        if (record.email) {
          await sendCertificationUpdate({ email: record.email, repo, status: 'revoked', reason: notes });
        }
      }

      await store.set(`cert:${repo}`, JSON.stringify(record));

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ status: record.status, repo, decision, notes }),
      };
    }

    case 'list': {
      // List all certified repos (public, cacheable)
      const certified = [];
      try {
        const { blobs } = await store.list();
        for (const blob of blobs.filter(b => b.key.startsWith('cert:'))) {
          try {
            const raw = await store.get(blob.key);
            if (!raw) continue;
            const record = JSON.parse(raw);
            if (record.status === 'certified') {
              certified.push({
                repo: record.repo,
                score: record.score,
                certifiedAt: record.certifiedAt,
              });
            }
          } catch {}
        }
      } catch {}

      return {
        statusCode: 200,
        headers: { ...headers, 'Cache-Control': 'public, max-age=300' },
        body: JSON.stringify({ certified, total: certified.length }),
      };
    }

    default:
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
  }
};
