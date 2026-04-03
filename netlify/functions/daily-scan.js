/**
 * Scheduled Function: daily-scan
 * Runs at 8am UTC daily via Netlify Scheduled Functions.
 *
 * 1. Loads all monitored repos across all users
 * 2. Deduplicates repos
 * 3. Re-scores each unique repo (throttled 1/sec)
 * 4. Compares to stored lastScore
 * 5. If delta >= 0.3 or tier changed: sends alert email
 * 6. Updates stored scores
 */

const { connectLambda, getStore } = require('@netlify/blobs');
const { scoreAny } = require('../../lib/score-any');
const { sendScoreDropAlert, sendCertificationUpdate } = require('../../lib/email');

function monitorsStore() {
  return getStore('monitors');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

exports.handler = async (event) => {
  connectLambda(event);

  console.log('Daily scan started at', new Date().toISOString());

  const store = monitorsStore();

  // List all user records
  // Netlify Blobs list returns entries with keys
  let userKeys = [];
  try {
    const { blobs } = await store.list();
    userKeys = blobs.filter(b => b.key.startsWith('user:')).map(b => b.key);
  } catch (err) {
    console.error('Failed to list monitors:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to list monitors' }) };
  }

  if (userKeys.length === 0) {
    console.log('No monitored repos. Exiting.');
    return { statusCode: 200, body: JSON.stringify({ message: 'No monitors', scanned: 0 }) };
  }

  // Load all user records and collect unique repos + subscriber mapping
  const repoSubscribers = {}; // repo → [{ email, entry }]
  const userRecords = {};     // userKey → parsed record

  for (const key of userKeys) {
    try {
      const raw = await store.get(key);
      if (!raw) continue;
      const record = JSON.parse(raw);
      userRecords[key] = record;

      for (const entry of record.repos) {
        if (!repoSubscribers[entry.repo]) repoSubscribers[entry.repo] = [];
        repoSubscribers[entry.repo].push({ email: record.email, entry, userKey: key });
      }
    } catch (err) {
      console.error(`Failed to load ${key}:`, err.message);
    }
  }

  const uniqueRepos = Object.keys(repoSubscribers);
  console.log(`Scanning ${uniqueRepos.length} unique repos across ${userKeys.length} users`);

  const token = process.env.GITHUB_TOKEN || null;
  let scanned = 0;
  let alertsSent = 0;

  for (const repo of uniqueRepos) {
    try {
      const result = await scoreAny(repo, token);
      if (result.error) {
        console.warn(`Failed to score ${repo}: ${result.error}`);
        continue;
      }

      scanned++;
      const newScore = result.composite;
      const newTier = result.tier;

      // Check each subscriber for this repo
      for (const sub of repoSubscribers[repo]) {
        const oldScore = sub.entry.lastScore;
        const oldTier = sub.entry.lastTier;
        const delta = oldScore != null ? Math.round((newScore - oldScore) * 100) / 100 : null;

        // Update entry
        sub.entry.lastScore = newScore;
        sub.entry.lastTier = newTier;
        sub.entry.lastChecked = new Date().toISOString();

        // Send alert if significant change
        if (delta !== null && (Math.abs(delta) >= 0.3 || oldTier !== newTier)) {
          try {
            await sendScoreDropAlert({
              email: sub.email,
              repo,
              oldScore,
              newScore,
              oldTier,
              newTier,
            });
            alertsSent++;
            console.log(`Alert sent: ${repo} ${oldScore}→${newScore}`);
          } catch (emailErr) {
            console.error(`Failed to send alert for ${repo}`);
          }
        }
      }

      // Throttle: 1 request per second to stay under GitHub rate limits
      await sleep(1000);

    } catch (err) {
      console.error(`Error scanning ${repo}:`, err.message);
    }
  }

  // Save updated user records
  for (const [key, record] of Object.entries(userRecords)) {
    try {
      await store.set(key, JSON.stringify(record));
    } catch (err) {
      console.error(`Failed to save ${key}:`, err.message);
    }
  }

  // --- Certification revocation check ---
  let revoked = 0;
  try {
    const certStore = getStore('certifications');
    const { blobs: certBlobs } = await certStore.list();
    const certKeys = certBlobs.filter(b => b.key.startsWith('cert:')).map(b => b.key);

    for (const certKey of certKeys) {
      try {
        const raw = await certStore.get(certKey);
        if (!raw) continue;
        const record = JSON.parse(raw);
        if (record.status !== 'certified') continue;

        const repo = record.repo;

        const result = await scoreAny(repo, token, { skipPartial: true });
        if (result.error) continue;

        const signalCount = result.signals ? Object.values(result.signals).filter(v => v != null).length : 0;
        const shouldRevoke =
          result.composite < 7.0 ||
          (result.dimensions?.solid != null && result.dimensions.solid < 5.0) ||
          (result.disqualifiers?.length > 0) ||
          signalCount < 8;

        if (shouldRevoke) {
          const reason = `Auto-revoked: score=${result.composite}, solid=${result.dimensions?.solid}, disqualifiers=${result.disqualifiers?.join(',') || 'none'}`;
          record.status = 'revoked';
          record.revokedAt = new Date().toISOString();
          record.log.push({ action: 'revoked', at: new Date().toISOString(), reason });
          await certStore.set(certKey, JSON.stringify(record));
          revoked++;

          if (record.email) {
            await sendCertificationUpdate({ email: record.email, repo, status: 'revoked', reason });
          }
          console.log(`Certification revoked: ${repo} — ${reason}`);
        } else {
          // Still valid — log rescan
          record.log.push({ action: 'rescanned', at: new Date().toISOString(), score: result.composite, passed: true });
          await certStore.set(certKey, JSON.stringify(record));
        }

        await sleep(1000);
      } catch (err) {
        console.error(`Cert check failed for ${certKey}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Certification revocation check failed:', err.message);
  }

  const summary = {
    message: 'Daily scan complete',
    scanned,
    uniqueRepos: uniqueRepos.length,
    users: userKeys.length,
    alertsSent,
    certificationsRevoked: revoked,
    completedAt: new Date().toISOString(),
  };

  console.log('Daily scan summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};
