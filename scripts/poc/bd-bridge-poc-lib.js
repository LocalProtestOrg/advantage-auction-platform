'use strict';

/**
 * bd-bridge-poc-lib.js — pure, testable logic for the Option B handoff PoC (NON-PRODUCTION).
 *
 * No Express, no I/O, no DB, no session, no user records. The server (bd-bridge-poc-server.js) and
 * the tests (tests/poc/bd-bridge-poc.test.js) both use this. Everything is deterministic when `now`
 * is injected, so expiry/replay are testable without wall-clock or network.
 *
 * Security invariants proven here:
 *  - the shared bridge secret is compared in CONSTANT TIME;
 *  - the browser-facing value is only a 256-bit OPAQUE code (no member id / secret / claims in it);
 *  - codes are stored HASHED, are SINGLE-USE, and EXPIRE (default 120s);
 *  - the redemption result carries the VERIFIED identity only — never a role, token, or authority.
 */

const crypto = require('crypto');

// Allowlisted destinations — callers pass a route KEY, never a URL.
const ALLOWED_DEST = {
  dashboard: '/dashboard',
  'create-event': '/org/event-new.html',
  'manage-events': '/org/events.html',
  'create-auction': '/seller-create.html',
  'manage-auctions': '/seller/dashboard',
};

function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false; // length check first; comparison itself is constant-time
  return crypto.timingSafeEqual(ba, bb);
}

const normalizeMemberId = (v) => String(v == null ? '' : v).trim();
const isMemberId = (v) => /^[0-9]{1,12}$/.test(v);
const isDest = (v) => Object.prototype.hasOwnProperty.call(ALLOWED_DEST, v);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** One-time opaque login codes, stored only as hashes. In-memory for the PoC (Neon table later). */
class CodeStore {
  constructor(opts) {
    this.ttlMs = (opts && opts.ttlMs) || 120000; // 2 minutes
    this.map = new Map(); // sha256(code) -> { bdUserId, dest, expiresAt, used }
  }

  issue(bdUserId, dest, now) {
    const t = now == null ? Date.now() : now;
    const code = crypto.randomBytes(32).toString('base64url'); // 256-bit opaque; no member id inside
    this.map.set(sha256(code), { bdUserId, dest, expiresAt: t + this.ttlMs, used: false });
    return code;
  }

  redeem(code, now) {
    const t = now == null ? Date.now() : now;
    const key = sha256(String(code == null ? '' : code));
    const rec = this.map.get(key);
    if (!rec) return { ok: false, reason: 'unknown' };
    if (rec.used) return { ok: false, reason: 'used' };       // replay
    if (t > rec.expiresAt) { this.map.delete(key); return { ok: false, reason: 'expired' }; }
    rec.used = true; this.map.set(key, rec);                  // single-use: consume before returning
    return { ok: true, bdUserId: rec.bdUserId, dest: rec.dest };
  }

  purge(now) {
    const t = now == null ? Date.now() : now;
    for (const [k, r] of this.map) if (t > r.expiresAt) this.map.delete(k);
  }

  get size() { return this.map.size; }
}

/**
 * Server-to-server issuance handler (BD → Railway). Pure: returns { status, json }.
 * ctx = { store, secret, now?, publicBaseUrl }.
 */
function handleExchange(input, ctx) {
  const secret = ctx && ctx.secret;
  if (!secret || !safeEqual(input && input.bridgeKeyHeader, secret)) {
    return { status: 401, json: { ok: false, error: 'invalid bridge credential' } };
  }
  const body = (input && input.body) || {};
  if (body.bd_user_id == null || body.dest == null) {
    return { status: 400, json: { ok: false, error: 'missing required fields' } };
  }
  const memberId = normalizeMemberId(body.bd_user_id);
  const dest = String(body.dest).trim();
  if (!isMemberId(memberId)) return { status: 400, json: { ok: false, error: 'member id must be numeric' } };
  if (!isDest(dest)) return { status: 400, json: { ok: false, error: 'destination not allowlisted' } };

  const code = ctx.store.issue(memberId, dest, ctx.now);
  const base = String((ctx.publicBaseUrl || '')).replace(/\/+$/, '');
  // Browser-facing value contains ONLY the opaque code — no member id, no secret, no claims.
  return { status: 200, json: { ok: true, code, redirect_url: base + '/auth/bd/return?code=' + encodeURIComponent(code) } };
}

/**
 * Browser redemption handler. Pure: returns { status, result }. Consumes the code once and returns
 * the VERIFIED identity only — NO session, NO role, NO ownership, NO authority. The real bridge does
 * identity-only linking downstream; organization ownership stays unclaimed/claim_pending elsewhere.
 */
function handleReturn(input, ctx) {
  const code = (input && input.query && input.query.code) || '';
  const r = ctx.store.redeem(code, ctx.now);
  if (!r.ok) return { status: 400, result: { ok: false, reason: r.reason } };
  return {
    status: 200,
    result: {
      ok: true,
      bd_user_id: r.bdUserId,                 // the verified identity (server-side use only)
      dest_path: ALLOWED_DEST[r.dest] || ALLOWED_DEST.dashboard,
      authenticated_identity_only: true,      // explicitly: identity proven, NO privileges granted
    },
  };
}

module.exports = {
  ALLOWED_DEST, safeEqual, normalizeMemberId, isMemberId, isDest, sha256,
  CodeStore, handleExchange, handleReturn,
};
