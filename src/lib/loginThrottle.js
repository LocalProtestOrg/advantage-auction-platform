'use strict';

/**
 * Per-account sign-in throttle (security audit 2026-10-15, owner item 6). The existing limiter is per IP address, so a
 * password-guessing run spread across many addresses was unlimited for one account. This adds a per-ACCOUNT limit:
 * after MAX_FAILURES wrong passwords for the same email within WINDOW_MS, sign-in for that email is refused for
 * LOCK_MS, from every address. A correct password after the lock expires clears the count.
 *
 * It applies identically to emails that have no account, so the response never reveals whether an account exists.
 * State is per server instance (production runs one instance); a restart clears it, which only ever loosens the limit.
 */
const { normalizeEmail } = require('./accountEmail');

const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_KEYS = 50000;
const state = new Map(); // email -> { failures: [ms...], lockedUntil: ms }

const LOCKED_BODY = Object.freeze({
  success: false,
  code: 'TOO_MANY_ATTEMPTS',
  error: 'Too many sign-in attempts for this account. Please wait 15 minutes, or reset your password.',
});

function entry(email) {
  const k = normalizeEmail(email);
  if (!k) return null;
  let e = state.get(k);
  if (!e) { if (state.size >= MAX_KEYS) state.clear(); e = { failures: [], lockedUntil: 0 }; state.set(k, e); }
  return e;
}

/** Milliseconds left on this account's lock (0 when sign-in may be attempted). */
function lockedFor(email) {
  const e = state.get(normalizeEmail(email));
  return e && e.lockedUntil > Date.now() ? e.lockedUntil - Date.now() : 0;
}

function recordFailure(email) {
  const e = entry(email); if (!e) return;
  const now = Date.now();
  e.failures = e.failures.filter((t) => now - t < WINDOW_MS);
  e.failures.push(now);
  if (e.failures.length >= MAX_FAILURES) { e.lockedUntil = now + LOCK_MS; e.failures = []; console.warn('[auth] account sign-in temporarily locked after repeated wrong passwords'); }
}

function recordSuccess(email) { state.delete(normalizeEmail(email)); }

function _reset() { state.clear(); }

module.exports = { lockedFor, recordFailure, recordSuccess, LOCKED_BODY, MAX_FAILURES, WINDOW_MS, LOCK_MS, _reset };
