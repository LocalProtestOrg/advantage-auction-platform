'use strict';

/**
 * Number-level do-not-text list (migration 190). A number lands here when it replies STOP (or a STOP-family keyword),
 * or when the provider reports it as unsubscribed (Twilio error 21610). While suppressed, NOTHING is texted to it:
 * optional auction alerts, Phone Sasha texts and payment links all check isSuppressed() before sending.
 *
 * START / UNSTOP releases the number (texting becomes possible again) but never turns optional alerts back on; the
 * customer must opt in again on the website, which records fresh consent.
 *
 * Only a salted hash and the last 4 digits are stored; the full number never appears in this table or in logs.
 */

const db = require('../db');
const { normalizeUsPhone, identifierHash, last4 } = require('../lib/phoneNumber');

const UNSUBSCRIBED_ERROR_CODES = new Set([21610]);   // Twilio: "Attempt to send to unsubscribed recipient"

function key(e164) { const n = normalizeUsPhone(e164); return n.e164 ? { hash: identifierHash(n.e164), last4: last4(n.e164) } : null; }

async function isSuppressed(e164, runner = db) {
  const k = key(e164); if (!k) return false;
  const r = (await runner.query(`SELECT status FROM sms_suppressions WHERE phone_hash = $1`, [k.hash])).rows[0];
  return !!(r && r.status === 'suppressed');
}

async function suppress(e164, { reason = 'stop_keyword', keyword = null } = {}, runner = db) {
  const k = key(e164); if (!k) return { suppressed: false };
  await runner.query(`INSERT INTO sms_suppressions (phone_hash, phone_last4, status, reason, keyword, suppressed_at, updated_at)
      VALUES ($1,$2,'suppressed',$3,$4, now(), now())
    ON CONFLICT (phone_hash) DO UPDATE SET status = 'suppressed', reason = EXCLUDED.reason, keyword = EXCLUDED.keyword,
      suppressed_at = CASE WHEN sms_suppressions.status = 'suppressed' THEN sms_suppressions.suppressed_at ELSE now() END,
      released_at = NULL, release_reason = NULL, updated_at = now()`, [k.hash, k.last4, reason, keyword]);
  return { suppressed: true, last4: k.last4 };
}

/** START / UNSTOP: texting to the number is allowed again. Optional alerts stay OFF until the customer opts in again. */
async function release(e164, { reason = 'start_keyword' } = {}, runner = db) {
  const k = key(e164); if (!k) return { released: false };
  const r = await runner.query(`UPDATE sms_suppressions SET status = 'released', released_at = now(), release_reason = $2, updated_at = now()
    WHERE phone_hash = $1 AND status = 'suppressed'`, [k.hash, reason]);
  return { released: r.rowCount > 0 };
}

/** True when a provider error means the recipient has unsubscribed (treated exactly like STOP). */
function isUnsubscribedError(e) { return !!(e && UNSUBSCRIBED_ERROR_CODES.has(Number(e.code))); }

/**
 * Call from any sender's catch block. If the provider says the number unsubscribed, suppress it and turn off every
 * optional alert tied to it. Returns true when the error was handled as an unsubscribe.
 */
async function handleSendError(e, e164) {
  if (!isUnsubscribedError(e)) return false;
  await suppress(e164, { reason: 'provider_unsubscribed' });
  await require('./smsConsentService').optOutNumber(e164, { source: 'sms_keyword', context: { provider_error: Number(e.code) } });
  return true;
}

module.exports = { isSuppressed, suppress, release, isUnsubscribedError, handleSendError, UNSUBSCRIBED_ERROR_CODES };
