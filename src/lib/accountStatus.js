'use strict';

/**
 * accountStatus — server-side re-check of an already-authenticated session's account status.
 *
 * Account suspension is `users.is_active = false` (migration 046). Login, auction registration and
 * bidding already refuse inactive accounts, but a JWT issued BEFORE the suspension stays valid until
 * it expires. authMiddleware uses this module to refuse state-changing requests from a suspended
 * account and to stop renewing its session.
 *
 * A short per-user cache (CACHE_TTL_MS) bounds the extra DB load. Only a DEFINITIVE status is cached:
 * an unknown user row, a lookup error or a lookup timeout returns null ("unknown") and is NEVER cached.
 * Callers FAIL CLOSED on unknown for state-changing requests (503 ACCOUNT_STATUS_UNAVAILABLE — a neutral
 * retry message that never says "suspended"); read-only requests are not refused on unknown.
 */

const db = require('../db');

const CACHE_TTL_MS = 30 * 1000;
const CACHE_MAX = 10000;
const LOOKUP_TIMEOUT_MS = 5000;
const cache = new Map(); // userId -> { active: boolean, at: ms }

const SUSPENDED_BODY = Object.freeze({
  success: false,
  code: 'ACCOUNT_SUSPENDED',
  error: 'This account is suspended. Please contact Advantage.Bid support.',
  message: 'This account is suspended. Please contact Advantage.Bid support.',
});

// Status could not be reliably determined (lookup error / timeout / no row) — neutral, retryable.
const UNAVAILABLE_BODY = Object.freeze({
  success: false,
  code: 'ACCOUNT_STATUS_UNAVAILABLE',
  error: 'ACCOUNT_STATUS_UNAVAILABLE',
  message: 'We could not complete this request right now. Please try again shortly.',
});

// Cached status: true / false, or undefined when not cached (or expired).
function cachedActive(userId) {
  const hit = cache.get(String(userId));
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(String(userId)); return undefined; }
  return hit.active;
}

// Resolves true (active), false (suspended) or null (unknown — row missing or lookup failed).
async function isAccountActive(userId) {
  const c = cachedActive(userId);
  if (c !== undefined) return c;
  let timer;
  try {
    const r = await Promise.race([
      db.query('SELECT is_active FROM users WHERE id = $1', [userId]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('status lookup timed out')), LOOKUP_TIMEOUT_MS); }),
    ]);
    const row = r && Array.isArray(r.rows) ? r.rows[0] : undefined;
    if (!row || typeof row.is_active !== 'boolean') return null;
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(String(userId), { active: row.is_active, at: Date.now() });
    return row.is_active;
  } catch (err) {
    console.warn('[accountStatus] lookup failed:', err && err.message);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// For routes that accept an OPTIONAL session but change state (e.g. a signed-in claim): when a session is
// present, apply the same rule as authMiddleware — suspended → 403, unknown → 503. Anonymous requests pass.
function refuseInactiveSignedIn(req, res, next) {
  if (!req.user || !req.user.id) return next();
  const c = cachedActive(req.user.id);
  const decide = (active) => {
    if (active === false) return res.status(403).json(SUSPENDED_BODY);
    if (active !== true) return res.status(503).json(UNAVAILABLE_BODY);
    return next();
  };
  if (c !== undefined) return decide(c);
  return isAccountActive(req.user.id).catch(() => null).then(decide);
}

// Called after an admin suspends/reactivates an account so this instance applies it immediately.
function invalidateAccountStatus(userId) {
  if (userId != null) cache.delete(String(userId));
}

function _clearAccountStatusCache() { cache.clear(); }

module.exports = {
  isAccountActive,
  cachedActive,
  invalidateAccountStatus,
  refuseInactiveSignedIn,
  SUSPENDED_BODY,
  UNAVAILABLE_BODY,
  CACHE_TTL_MS,
  LOOKUP_TIMEOUT_MS,
  _clearAccountStatusCache,
};
