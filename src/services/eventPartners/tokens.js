'use strict';

/**
 * tokens — the shared secret-handling primitives for Event Partner authorization links and
 * organization claim links.
 *
 * Rules that every caller depends on:
 *   - The RAW token is generated here, returned to the caller exactly once, and is NEVER persisted.
 *     Only sha256(raw) reaches the database, so a database disclosure cannot forge a link.
 *   - Lookups are by hash, so the raw value never appears in a query log either.
 *   - Comparison of any two secrets is constant-time (timingSafeEqual) — never `===`.
 *   - IPs are one-way hashed with the same 16-hex-prefix shape analytics_events already uses, so the
 *     evidence record can show "a different network presented this" without storing a raw address.
 *
 * The token is 32 bytes of crypto randomness in base64url (43 chars). That is well beyond guessing
 * range, so the link itself is the credential — but every consumer additionally binds it to an
 * organization, a purpose and (for claims) a verified recipient, so a leaked link alone is not enough.
 */

const crypto = require('crypto');

const TOKEN_BYTES = 32;
// base64url alphabet only; fixed length. Anything else is rejected before it ever reaches the DB.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Mint a new raw token. Return it to the caller once; store only hashToken(raw). */
function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** sha256 hex of a raw token. The only form that is ever persisted. */
function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw == null ? '' : raw)).digest('hex');
}

/** Shape check before any database work — a malformed token can never cause a lookup. */
function isWellFormed(raw) {
  return typeof raw === 'string' && TOKEN_RE.test(raw);
}

/** Constant-time equality for two hex digests (or any two equal-length secrets). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * One-way IP hash for evidence records. Mirrors analyticsService.hashIp: first address from a
 * comma-separated x-forwarded-for, loopback dropped, sha256 truncated to 16 hex characters.
 */
function hashIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const raw = ip.split(',')[0].trim();
  if (!raw || raw === '127.0.0.1' || raw === '::1') return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** Expiry helper: now + days, as a Date. */
function expiresInDays(days) {
  const d = Number(days);
  const n = Number.isFinite(d) && d > 0 ? d : 30;
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

module.exports = { mintToken, hashToken, isWellFormed, safeEqual, hashIp, expiresInDays, TOKEN_RE };
