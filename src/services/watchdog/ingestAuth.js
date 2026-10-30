'use strict';

/**
 * ingestAuth — HMAC authentication for browser-watchdog results posted to POST /api/watchdog/ingest.
 *
 *   X-Watchdog-Timestamp: <unix seconds>
 *   X-Watchdog-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with WATCHDOG_INGEST_KEY>
 *
 * Refused when the key is not configured (nothing can be posted at all), when either header is missing, when the
 * timestamp is more than 5 minutes away from the server clock, or when the signature does not match (constant time).
 */

const crypto = require('crypto');

const MAX_SKEW_S = 300;

function sign(key, timestamp, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', String(key)).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** → { ok: true } or { ok: false, status, code } */
function verify({ key = process.env.WATCHDOG_INGEST_KEY, timestamp, signature, rawBody, now = Date.now() } = {}) {
  if (!key || String(key).length < 32) return { ok: false, status: 503, code: 'INGEST_DISABLED' };
  if (!timestamp || !signature) return { ok: false, status: 401, code: 'SIGNATURE_REQUIRED' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_S) return { ok: false, status: 401, code: 'TIMESTAMP_INVALID' };
  const expected = Buffer.from(sign(key, String(timestamp), Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')));
  const given = Buffer.from(String(signature));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, status: 401, code: 'SIGNATURE_INVALID' };
  // Each signed submission is accepted once: a copy replayed inside the time window is refused.
  const seenKey = crypto.createHash('sha256').update(String(signature)).digest('hex');
  for (const [k, at] of SEEN) if (now - at > 2 * MAX_SKEW_S * 1000) SEEN.delete(k);
  if (SEEN.has(seenKey)) return { ok: false, status: 409, code: 'REPLAYED' };
  SEEN.set(seenKey, now);
  return { ok: true };
}
const SEEN = new Map();   // signature hash → accepted at (ms); one web process

module.exports = { sign, verify, MAX_SKEW_S, _seen: SEEN };
