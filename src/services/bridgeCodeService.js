'use strict';

/**
 * bridgeCodeService — short-lived, single-use, HASHED opaque handoff codes + validation helpers.
 *
 * The raw code is a 256-bit random value returned once to the caller and NEVER stored (only its
 * sha256 is persisted). Redemption is ATOMIC single-use at the DB level, so replay and races cannot
 * yield a second success. Destinations are an allowlist of route KEYS → internal paths (never a URL
 * supplied by the browser/BD), which prevents open-redirects.
 */

const crypto = require('crypto');
const db = require('../db');

const TTL_MS = 120000; // 2 minutes

// Route KEY → internal path. The browser/BD only ever supplies a KEY; the path is resolved here.
const ALLOWED_DEST = {
  dashboard: '/dashboard.html',
  'create-event': '/org/event-new.html',
  'manage-events': '/org/events.html',
  'create-auction': '/seller-create.html',
  'manage-auctions': '/dashboard/seller.html',
};
function resolveDest(key) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_DEST, key) ? ALLOWED_DEST[key] : ALLOWED_DEST.dashboard;
}
function isDest(key) { return Object.prototype.hasOwnProperty.call(ALLOWED_DEST, key); }
function normalizeMemberId(v) { return String(v == null ? '' : v).trim(); }
function isMemberId(v) { return /^[0-9]{1,12}$/.test(v); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false; // length guard first; comparison is constant-time
  return crypto.timingSafeEqual(ba, bb);
}

async function mint(bdUserId, dest) {
  const raw = crypto.randomBytes(32).toString('base64url'); // 256-bit opaque; carries no identity
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.query(
    'INSERT INTO bd_login_codes (code_hash, bd_user_id, dest, expires_at) VALUES ($1,$2,$3,$4)',
    [sha256(raw), String(bdUserId), String(dest), expiresAt]);
  return raw;
}

async function redeem(rawCode) {
  // Atomic single-use: claim ONLY an unused, unexpired row. Anything else (unknown/expired/replayed)
  // returns no row → no identity, no session.
  const { rows } = await db.query(
    `UPDATE bd_login_codes SET used_at = now()
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING bd_user_id, dest`,
    [sha256(String(rawCode == null ? '' : rawCode))]);
  return rows[0] || null;
}

module.exports = {
  TTL_MS, ALLOWED_DEST, resolveDest, isDest, normalizeMemberId, isMemberId, sha256, safeEqual, mint, redeem,
};
