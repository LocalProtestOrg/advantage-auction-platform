'use strict';

/**
 * US phone number normalization for Phone Sasha (pure, no I/O).
 *
 * users.phone is free text typed by people ("(551) 655-7050", "551.655.7050 x12", "+1 551 655 7050"). This NEVER
 * rewrites it: callers normalize on read and only an unambiguous NANP number becomes an E.164 value. Anything with an
 * extension, letters, the wrong length or an impossible area code/exchange is reported, not guessed.
 *
 *   normalizeUsPhone(raw) → { status, e164, reason }
 *     status: 'ok' | 'empty' | 'extension' | 'international' | 'invalid'
 */

const crypto = require('crypto');

function normalizeUsPhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { status: 'empty', e164: null, reason: 'no number' };
  if (/(ext\.?|extension|x|#)\s*\d+\s*$/i.test(s) && /\d{10}/.test(s.replace(/\D/g, ''))) {
    return { status: 'extension', e164: null, reason: 'has an extension' };
  }
  if (/[a-z]/i.test(s)) return { status: 'invalid', e164: null, reason: 'contains letters' };
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (plus && !d.startsWith('1')) return { status: 'international', e164: null, reason: 'non-US country code' };
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  else if (d.length !== 10) return { status: plus || d.length > 11 ? 'international' : 'invalid', e164: null, reason: d.length + ' digits' };
  // NANP: area code and exchange cannot start with 0 or 1; N11 area codes are service codes.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return { status: 'invalid', e164: null, reason: 'not a valid US number' };
  if (/^[2-9]11/.test(d)) return { status: 'invalid', e164: null, reason: 'service code' };
  if (d.slice(3, 6) === '555' && /^01\d\d$/.test(d.slice(6))) return { status: 'invalid', e164: null, reason: 'fictional 555-01xx number' };
  return { status: 'ok', e164: '+1' + d, reason: null };
}

/** Candidate raw-digit forms of an E.164 US number, for an index-free SQL pre-filter (the result is re-checked in JS). */
function digitForms(e164) {
  const m = /^\+1(\d{10})$/.exec(String(e164 || ''));
  return m ? [m[1], '1' + m[1]] : [];
}

function last4(e164) { const d = String(e164 || '').replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : null; }

/** Salted hash of a phone number or identifier, so caller numbers are linkable for rate limits but never stored. */
function identifierHash(value) {
  const pepper = process.env.SASHA_PHONE_HASH_SALT || ('sasha-phone:' + (process.env.JWT_SECRET || 'dev'));
  return crypto.createHmac('sha256', pepper).update(String(value || '').trim().toLowerCase()).digest('hex');
}

module.exports = { normalizeUsPhone, digitForms, last4, identifierHash };
