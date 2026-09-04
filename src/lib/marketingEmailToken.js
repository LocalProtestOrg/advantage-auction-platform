'use strict';

/**
 * marketingEmailToken — stateless, signed one-click tokens for MARKETING emails (unsubscribe + click).
 *
 * A token encodes the contact's normalized_email (+ optional campaign/event refs) signed with HMAC-SHA256,
 * so the public marketing-email endpoints can act WITHOUT the recipient logging in. Unlike the follower
 * token (which carries UUIDs), the marketing unsubscribe must write to email_suppressions by normalized
 * email — so the email is the payload, protected by the signature. Tokens do not expire.
 *
 * Secret precedence: MARKETING_EMAIL_SECRET → JWT_SECRET → dev fallback.
 */
const crypto = require('crypto');

function secret() {
  return process.env.MARKETING_EMAIL_SECRET || process.env.JWT_SECRET || 'dev-marketing-email-secret';
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hmac(data) {
  return b64url(crypto.createHmac('sha256', secret()).update(data).digest());
}

// sign({ email, campaign, event }) → "<payload>.<sig>"; payload = base64url(JSON).
function sign(claims) {
  const payload = b64url(JSON.stringify({ e: claims.email, c: claims.campaign || null, v: claims.event || null }));
  return `${payload}.${hmac(payload)}`;
}

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
  try {
    const obj = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!obj || !obj.e) return null;
    return { email: obj.e, campaign: obj.c || null, event: obj.v || null };
  } catch (_) { return null; }
}

module.exports = { sign, verify };
