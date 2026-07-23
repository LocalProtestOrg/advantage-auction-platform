'use strict';

/**
 * bridgeCodeService — short-lived, single-use, HASHED opaque handoff codes + validation helpers.
 *
 * The raw code is a 256-bit random value returned once to the caller and NEVER stored (only its
 * sha256 is persisted). It also carries the authenticated identity CLAIMS (email/name) captured at
 * the server-to-server exchange, so the browser never sees them. Redemption is claimed atomically
 * together with identity provisioning in bridgeIdentityService.redeemAndProvision (one transaction,
 * rollback-safe: a provisioning failure does NOT burn the code). Destinations are an allowlist of
 * route KEYS → internal paths (never a URL supplied by the browser/BD), preventing open-redirects.
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
function normalizeName(v) { return String(v == null ? '' : v).trim().slice(0, 100); }
function normalizeEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function isEmail(v) { return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false; // length guard first; comparison is constant-time
  return crypto.timingSafeEqual(ba, bb);
}

// Mint an opaque code and persist its hash + the authenticated identity claims. claims = { email,
// firstName, lastName } — captured server-side at exchange; the browser only ever receives `raw`.
async function mint(bdUserId, dest, claims) {
  const raw = crypto.randomBytes(32).toString('base64url'); // 256-bit opaque; carries no identity
  const expiresAt = new Date(Date.now() + TTL_MS);
  const c = claims || {};
  await db.query(
    `INSERT INTO bd_login_codes
       (code_hash, bd_user_id, dest, expires_at, provider_email, provider_first_name, provider_last_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sha256(raw), String(bdUserId), String(dest), expiresAt, c.email || null, c.firstName || null, c.lastName || null]);
  return raw;
}

module.exports = {
  TTL_MS, ALLOWED_DEST, resolveDest, isDest,
  normalizeMemberId, isMemberId, normalizeName, normalizeEmail, isEmail,
  sha256, safeEqual, mint,
};
