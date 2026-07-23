'use strict';

/**
 * bridgeHandlers — pure, dependency-injected request logic for the identity bridge (testable without
 * Express, DB, or network). The Express router (routes/authBridge.js) wires req→handler→res.
 *
 * Option 2 delivery: on successful redemption we reuse the EXISTING login JWT and return a minimal,
 * uncacheable, transparent SEED page whose ONLY job is to store the JWT in localStorage and
 * location.replace() to the allowlisted destination. The JWT appears only inside a nonce'd inline
 * script — never in the URL, a Location header, query string, fragment, or the browser history.
 */

const crypto = require('crypto');
const {
  safeEqual, normalizeMemberId, isMemberId, isDest, resolveDest,
  normalizeEmail, isEmail, normalizeName,
} = require('./bridgeCodeService');

// ── Server-to-server issuance (BD → app), authenticated by the shared secret ──
async function handleExchange(input, ctx) {
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

  // A real, deliverable member email is REQUIRED so a bridge account is never created without a real
  // inbox (its namespaced users.email is undeliverable). Trusted because it arrives only on the
  // secret-authenticated server-to-server request — never from the browser.
  const email = normalizeEmail(body.email);
  if (!isEmail(email)) return { status: 400, json: { ok: false, error: 'valid member email required' } };
  const claims = { email, firstName: normalizeName(body.first_name), lastName: normalizeName(body.last_name) };

  const code = await ctx.mintCode(memberId, dest, claims);
  // Browser-facing value: ONLY the opaque code.
  return { status: 200, json: { ok: true, redirect_url: ctx.publicAppUrl + '/auth/bd/return?code=' + encodeURIComponent(code) } };
}

const SEED_SECURITY_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
  Expires: '0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/** Minimal transparent seed page. JWT lives ONLY in the nonce'd inline script. */
function buildSeed(jwt, destPath) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="robots" content="noindex,nofollow"><title>&nbsp;</title></head><body>'
    + '<noscript>JavaScript is required to continue.</noscript>'
    + '<script nonce="' + nonce + '">'
    + 'try{localStorage.setItem("token",' + JSON.stringify(String(jwt)) + ');}catch(e){}'
    + 'location.replace(' + JSON.stringify(String(destPath)) + ');'
    + '</script></body></html>';
  const headers = Object.assign({ 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; base-uri 'none'; form-action 'none'" },
    SEED_SECURITY_HEADERS);
  return { headers, html, nonce };
}

function errorPage() {
  return '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>&nbsp;</title>'
    + '<body style="font:16px system-ui;max-width:520px;margin:64px auto;padding:0 20px">'
    + '<p>This sign-in link is no longer valid. Please return to Advantage.bid and try again.</p></body>';
}
const ERROR_HEADERS = Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, SEED_SECURITY_HEADERS);

// ── Browser redemption → transparent seed ──
async function handleReturn(input, ctx) {
  const code = (input && input.query && input.query.code) || '';
  // Atomic redeem + provision (single-use claim and identity provisioning share one transaction).
  const result = await ctx.redeemAndProvision(code); // { dest, userId, role } or null
  if (!result) {
    return { status: 400, headers: ERROR_HEADERS, html: errorPage() }; // failed/expired/replayed/unknown → NO JWT
  }
  const jwt = ctx.signJwt({ id: result.userId, role: result.role }); // SAME login JWT, same claims
  const seed = ctx.buildSeed(jwt, resolveDest(result.dest));
  return { status: 200, headers: seed.headers, html: seed.html };
}

module.exports = { handleExchange, handleReturn, buildSeed, errorPage, ERROR_HEADERS, SEED_SECURITY_HEADERS };
