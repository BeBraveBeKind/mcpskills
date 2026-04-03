/**
 * lib/auth.js — API key management, rate limiting, and mode detection
 *
 * Uses Netlify Blobs for persistent storage of:
 *   - API keys (api-keys store)
 *   - Rate limit counters (rate-limits store)
 *
 * Key format: msk_ + 32 hex chars
 * Rate limits: human free = 3/day per IP, agent free = 20/day per IP
 */

const crypto = require('crypto');

// Lazy-init blob stores to avoid import issues outside Netlify runtime
let _apiKeysStore = null;
let _rateLimitsStore = null;
let _getStore = null;

function loadGetStore() {
  if (!_getStore) {
    _getStore = require('@netlify/blobs').getStore;
  }
  return _getStore;
}

function apiKeysStore() {
  if (!_apiKeysStore) _apiKeysStore = loadGetStore()('api-keys');
  return _apiKeysStore;
}

function rateLimitsStore() {
  if (!_rateLimitsStore) _rateLimitsStore = loadGetStore()('rate-limits');
  return _rateLimitsStore;
}

// --- Mode Detection ---

function detectMode(event) {
  const accept = (event.headers?.accept || '').toLowerCase();
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-API-Key'];
  const modeParam = event.queryStringParameters?.mode;

  // #7: Do not allow mode override via query param — prevents rate limit bypass
  if (apiKey) return 'agent';
  if (accept.includes('application/json') && !accept.includes('text/html')) return 'agent';

  // Browser-like User-Agent without API key → human
  const ua = (event.headers?.['user-agent'] || '').toLowerCase();
  if (ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari')) return 'human';

  return 'agent'; // default for scripts/curl
}

// --- IP Hashing ---

function hashIP(event) {
  const ip = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || event.headers?.['client-ip']
    || event.headers?.['x-nf-client-connection-ip']
    || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// --- Rate Limiting ---

const LIMITS = {
  human: { free: 3, window: 'day' },
  agent: { free: 20, window: 'day' },
  badge: { free: 100, window: 'hour' },
};

function rateLimitKey(ipHash, mode) {
  const now = new Date();
  const dateKey = mode === 'badge'
    ? `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`
    : `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
  return `${mode}:${ipHash}:${dateKey}`;
}

async function checkRateLimit(ipHash, mode) {
  const limit = LIMITS[mode]?.free || 20;
  const key = rateLimitKey(ipHash, mode);

  try {
    const store = await rateLimitsStore();
    const raw = await store.get(key);
    const count = raw ? parseInt(raw, 10) : 0;

    if (count >= limit) {
      const now = new Date();
      let resetAt;
      if (mode === 'badge') {
        resetAt = new Date(now);
        resetAt.setUTCHours(resetAt.getUTCHours() + 1, 0, 0, 0);
      } else {
        resetAt = new Date(now);
        resetAt.setUTCDate(resetAt.getUTCDate() + 1);
        resetAt.setUTCHours(0, 0, 0, 0);
      }
      return { allowed: false, remaining: 0, resetAt: resetAt.toISOString(), limit };
    }

    // Increment counter — NOTE: not atomic, concurrent requests may bypass limit briefly
    // Netlify Blobs does not support atomic increments. Acceptable for current scale.
    await store.set(key, String(count + 1));
    return { allowed: true, remaining: limit - count - 1, limit };
  } catch (err) {
    console.warn('Rate limit check failed:', err.message);
    // Fail closed in production, open in local dev
    if (process.env.NETLIFY) {
      return { allowed: false, remaining: 0, limit, error: 'Rate limiter unavailable' };
    }
    return { allowed: true, remaining: 999, limit };
  }
}

// --- API Key Management ---

function generateKeyString() {
  return 'msk_' + crypto.randomBytes(16).toString('hex');
}

/** Hash a key for storage lookup — never store the raw key */
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function generateApiKey(email, credits, source = 'purchase') {
  const key = generateKeyString();
  const keyHash = hashKey(key);
  const record = {
    email,
    credits, // null = unlimited (Pro)
    source,  // 'purchase', 'subscription', 'admin'
    tier: credits === null ? 'pro' : 'paid',
    keyPrefix: key.slice(0, 12), // msk_ + 8 hex for reference only
    createdAt: new Date().toISOString(),
    lastUsed: null,
    totalUsed: 0,
  };

  const store = await apiKeysStore();
  await store.set(keyHash, JSON.stringify(record));
  return key;
}

async function validateApiKey(key) {
  if (!key || !key.startsWith('msk_')) {
    return { valid: false, reason: 'Invalid key format' };
  }

  try {
    const store = await apiKeysStore();
    const keyHash = hashKey(key);
    const raw = await store.get(keyHash);
    if (!raw) {
      // Backwards compat: check if stored by raw key (pre-hash migration)
      const rawLegacy = await store.get(key);
      if (rawLegacy) {
        // Migrate: re-store under hash, delete old key
        await store.set(keyHash, rawLegacy);
        try { await store.delete(key); } catch {}
        return validateApiKey(key); // re-validate from hash
      }
      return { valid: false, reason: 'Key not found' };
    }

    const record = JSON.parse(raw);

    // Check credits (null = unlimited for Pro)
    if (record.credits !== null && record.credits <= 0) {
      return { valid: false, reason: 'No credits remaining', email: record.email, tier: record.tier };
    }

    return {
      valid: true,
      email: record.email,
      tier: record.tier,
      credits: record.credits,
      source: record.source,
    };
  } catch (err) {
    console.error('API key validation error');
    return { valid: false, reason: 'Validation error' };
  }
}

async function consumeCredit(key) {
  try {
    const store = await apiKeysStore();
    const keyHash = hashKey(key);
    const raw = await store.get(keyHash);
    if (!raw) return { success: false, remaining: 0 };

    const record = JSON.parse(raw);

    // Pro tier — unlimited
    if (record.credits === null) {
      record.totalUsed++;
      record.lastUsed = new Date().toISOString();
      await store.set(keyHash, JSON.stringify(record));
      return { success: true, remaining: null };
    }

    if (record.credits <= 0) {
      return { success: false, remaining: 0 };
    }

    record.credits--;
    record.totalUsed++;
    record.lastUsed = new Date().toISOString();
    await store.set(keyHash, JSON.stringify(record));

    return { success: true, remaining: record.credits };
  } catch (err) {
    console.error('Credit consumption error');
    return { success: false, remaining: 0 };
  }
}

// --- Main Auth Entry Point ---

async function authenticateRequest(event) {
  const mode = detectMode(event);
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-API-Key'] || null;

  // If API key provided, validate it
  if (apiKey) {
    const validation = await validateApiKey(apiKey);
    if (!validation.valid) {
      return {
        authenticated: false,
        mode,
        tier: 'free',
        error: validation.reason,
        errorCode: validation.reason === 'No credits remaining' ? 403 : 401,
      };
    }
    return {
      authenticated: true,
      mode,
      tier: validation.tier,
      email: validation.email,
      credits: validation.credits,
      key: apiKey,
    };
  }

  // No API key — check rate limit
  const ipHash = hashIP(event);
  const rateCheck = await checkRateLimit(ipHash, mode);

  if (!rateCheck.allowed) {
    return {
      authenticated: false,
      mode,
      tier: 'free',
      error: 'Rate limit exceeded',
      errorCode: 429,
      limit: rateCheck.limit,
      resetAt: rateCheck.resetAt,
    };
  }

  return {
    authenticated: true,
    mode,
    tier: 'free',
    remaining: rateCheck.remaining,
  };
}

// --- Response Builders ---

function buildAgentResponse(result) {
  // Partial scores are never "safe" — no source code analysis
  const isPartial = result.limited || result.mode === 'partial';
  const safe = !isPartial
    && (result.tier === 'verified' || result.tier === 'established')
    && (!result.disqualifiers || result.disqualifiers.length === 0);

  let recommendation;
  if (isPartial) recommendation = 'caution';
  else if (result.disqualifiers?.length > 0) recommendation = 'avoid';
  else if (result.tier === 'blocked') recommendation = 'blocked';
  else if (result.tier === 'verified') recommendation = 'install';
  else recommendation = 'caution';

  const flags = [];
  if (isPartial) flags.push('LIMITED_NO_SOURCE');
  if (result.disqualifiers?.length > 0) flags.push(...result.disqualifiers);
  if (result.dimensions) {
    for (const [dim, val] of Object.entries(result.dimensions)) {
      if (val !== null && val < 4.5) flags.push(`low_${dim}`);
    }
  }

  return {
    repo: result.repo || null,
    package: result.package || null,
    safe,
    tier: result.tier,
    score: result.composite,
    recommendation,
    certified: !!result.certified,
    limited: isPartial || undefined,
    flags,
    reasoning: buildReasoning(result, safe),
    cached: !!result.cached,
    scannedAt: result.scannedAt,
    fullReportAvailable: true,
  };
}

function buildReasoning(result, safe) {
  const parts = [];
  const isPartial = result.limited || result.mode === 'partial';

  if (isPartial) {
    parts.push(`limited: ${result.signalCount || '?'}/${result.totalPossibleSignals || 14} signals (npm only)`);
    parts.push('no source code analysis');
    return parts.join(', ');
  }

  const signalCount = result.signals ? Object.keys(result.signals).length : 0;
  parts.push(`${signalCount} signals`);

  if (result.disqualifiers?.length > 0) {
    parts.push(`disqualifiers: ${result.disqualifiers.join(', ')}`);
  } else {
    parts.push('no disqualifiers');
  }

  if (result.mode === 'skills') parts.push('AI skill detected');

  if (result.skill?.safety?.findings?.length > 0) {
    parts.push(`${result.skill.safety.findings.length} safety finding(s)`);
  } else if (result.mode === 'skills') {
    parts.push('no safety findings');
  }

  return parts.join(', ');
}

function buildHumanFreeResponse(result) {
  const isPartial = result.limited || result.mode === 'partial';
  const response = {
    repo: result.repo || null,
    package: result.package || null,
    tier: result.tier,
    composite: result.composite,
    mode: result.mode,
    dimensions: result.dimensions || null,
    meta: {
      description: result.meta?.description || '',
      stars: result.meta?.stars || 0,
      license: result.meta?.license || 'Unknown',
    },
    fullReportAvailable: !isPartial,
  };
  if (isPartial) {
    response.limited = true;
    response.limitedReason = result.limitedReason;
    response.signalCount = result.signalCount;
    response.totalPossibleSignals = result.totalPossibleSignals;
  }
  if (result.resolvedFrom) {
    response.resolvedFrom = result.resolvedFrom;
  }
  return response;
}

function buildFullResponse(result) {
  // Return everything the scoring engine provides
  return result;
}

module.exports = {
  authenticateRequest,
  validateApiKey,
  generateApiKey,
  consumeCredit,
  checkRateLimit,
  detectMode,
  hashIP,
  buildAgentResponse,
  buildHumanFreeResponse,
  buildFullResponse,
};
