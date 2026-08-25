'use strict';

/**
 * followerEmailToken — stateless, signed one-click UNSUBSCRIBE tokens for follower marketing emails.
 *
 * A token encodes (userId, sellerId) and is signed with HMAC-SHA256 so the public unsubscribe endpoint
 * can act on it WITHOUT the recipient logging in and WITHOUT exposing any contact data. Tokens do not
 * expire (unsubscribe links must always work). The token reveals only opaque UUIDs, never an email.
 *
 * Secret precedence: FOLLOWER_EMAIL_SECRET → JWT_SECRET → a dev-only fallback (unit tests / local).
 */

const crypto = require('crypto');

function secret() {
  return process.env.FOLLOWER_EMAIL_SECRET || process.env.JWT_SECRET || 'dev-follower-email-secret';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hmac(data) {
  return b64url(crypto.createHmac('sha256', secret()).update(data).digest());
}

// sign(userId, sellerId) → "<payload>.<sig>" where payload = base64url("userId:sellerId").
function sign(userId, sellerId) {
  const payload = b64url(`${userId}:${sellerId}`);
  return `${payload}.${hmac(payload)}`;
}

// verify(token) → { userId, sellerId } or null. Uses a timing-safe comparison.
function verify(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = hmac(payload);
  let ok = false;
  try {
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return null; }
  if (!ok) return null;
  let decoded = '';
  try { decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch (_) { return null; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  const userId = decoded.slice(0, idx);
  const sellerId = decoded.slice(idx + 1);
  if (!userId || !sellerId) return null;
  return { userId, sellerId };
}

module.exports = { sign, verify };
