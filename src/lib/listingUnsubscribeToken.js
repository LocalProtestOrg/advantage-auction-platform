'use strict';

/**
 * listingUnsubscribeToken — signed one-click unsubscribe tokens for Claimed Listing outreach (RFC 8058).
 *
 * PURPOSE-BOUND: the HMAC covers a "listing_unsub:" prefix, so a consumer marketing unsubscribe token can
 * never be replayed here and a listing token can never unsubscribe someone from consumer marketing. The
 * payload carries the normalized address and the listing (organization) id; tokens do not expire.
 *
 * Secret: LISTING_OUTREACH_UNSUB_SECRET. The listing send gate refuses to send while it is unset (so every
 * token that was ever emailed was signed with it). Verification falls back to a JWT_SECRET-derived key
 * only so that a misconfiguration can never make a delivered link unverifiable.
 */

const crypto = require('crypto');

const PURPOSE = 'listing_unsub:';
function secret() {
  return process.env.LISTING_OUTREACH_UNSUB_SECRET || ((process.env.JWT_SECRET || 'dev-listing-unsub') + '|listing_unsub');
}
const configured = () => !!process.env.LISTING_OUTREACH_UNSUB_SECRET;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hmac = (data) => b64url(crypto.createHmac('sha256', secret()).update(PURPOSE + data).digest());

function sign({ email, organizationId }) {
  const payload = b64url(JSON.stringify({ e: String(email || '').toLowerCase(), o: organizationId || null }));
  return payload + '.' + hmac(payload);
}

function verify(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = hmac(payload);
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!obj || !obj.e) return null;
    return { email: obj.e, organizationId: obj.o || null };
  } catch (_) { return null; }
}

module.exports = { sign, verify, configured, PURPOSE };
