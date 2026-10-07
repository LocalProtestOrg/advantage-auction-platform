'use strict';

/**
 * 4-digit verification codes (Owner decision 2026-10-07: easier to read back on a phone call). The small code space
 * is compensated by the callers' controls: short expiry, few attempts per code, limited resends, per-account,
 * per-call and per-number throttles, lockout, single use. Shared by Phone Sasha and website phone verification.
 *
 * A code is never stored: only an HMAC of (record id + code). Comparison is constant-time.
 */

const crypto = require('crypto');

const CODE_LENGTH = 4;
const CODE_RE = /^\d{4}$/;

function generate() { return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0'); }

function hash(recordId, code) {
  const pepper = process.env.VERIFICATION_CODE_SALT || ('vcode:' + (process.env.JWT_SECRET || 'dev'));
  return crypto.createHmac('sha256', pepper).update(String(recordId) + ':' + String(code)).digest('hex');
}

function matches(storedHash, recordId, code) {
  if (!storedHash || !CODE_RE.test(String(code || ''))) return false;
  try { return crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(hash(recordId, code), 'hex')); } catch (_e) { return false; }
}

module.exports = { generate, hash, matches, CODE_LENGTH, CODE_RE };
