'use strict';

/**
 * One-time codes emailed to an account to confirm a sensitive change (migration 220; owner decision 2026-11-05).
 * Used when an account has no password it can confirm with (payoutSafeguards.assertIdentityForDestinationChange).
 *
 *   send(userId, purpose)                    → a 6-digit code to the account's own sign-in address (recipientService)
 *   consume(userId, purpose, code)           → true, or throws CodeError; a code works once, for that account and purpose
 *
 * Reuses the platform's existing pieces: the code hash and constant-time check of src/lib/verificationCode.js (a code is
 * never stored, only an HMAC of record id + code), the account address resolver used for every account email
 * (recipientService.resolveUserContactEmail, which reaches a directory sign-in account at its real address), the email
 * service, and the same control shape as the seller step-up and phone verification codes (sellerStepUpService,
 * accountPhoneService): short expiry, attempts counted atomically before comparing, limited sends, lockout, single use.
 * Every send and use is audited (no code, masked address only).
 */

const crypto = require('crypto');
const db = require('../db');
const code6 = require('../lib/verificationCode');
const { writeAuditLog } = require('../lib/auditLog');

const PURPOSES = Object.freeze({ PAYOUT_DESTINATION_CHANGE: 'payout_destination_change' });
const TTL_MIN = 10; const MAX_ATTEMPTS = 5; const SENDS_PER_30 = 3; const LOCK_MIN = 60; const LOCK_AFTER_FAILED = 10;
const CODE_RE = /^\d{6}$/;
const PURPOSE_TEXT = { payout_destination_change: 'change where your Advantage.Bid payouts are sent' };

class CodeError extends Error {
  constructor(code, message, status = 403, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); }
}

function maskEmail(e) {
  const s = String(e || ''); const at = s.indexOf('@');
  if (at < 1) return null;
  return s[0] + '***' + s.slice(at);
}
function generate() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function matches(storedHash, id, code) {
  if (!storedHash || !CODE_RE.test(String(code || ''))) return false;
  try { return crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(code6.hash(id, String(code)), 'hex')); } catch (_e) { return false; }
}
function checkPurpose(purpose) {
  if (!Object.values(PURPOSES).includes(purpose)) throw new CodeError('BAD_PURPOSE', 'Unknown verification purpose.', 400);
}
const n = async (sql, p) => Number((await db.query(sql, p)).rows[0].n) || 0;

async function locked(userId, purpose) {
  return (await n(`SELECT coalesce(sum(attempts), 0)::int n FROM account_verification_codes
    WHERE user_id = $1 AND purpose = $2 AND status <> 'used' AND created_at > now() - interval '${LOCK_MIN} minutes'`, [userId, purpose])) >= LOCK_AFTER_FAILED;
}

/** Send a code. Returns { sent, sent_to (masked), expires_in_minutes }. */
async function send(userId, purpose, deps = {}) {
  checkPurpose(purpose);
  const u = (await db.query('SELECT id, COALESCE(is_active, true) AS active FROM users WHERE id = $1', [userId])).rows[0];
  if (!u || !u.active) throw new CodeError('NO_USER', 'Account not available.');
  const to = await require('./recipientService').resolveUserContactEmail(userId);
  if (!to || !/@/.test(to)) throw new CodeError('NO_EMAIL', 'This account has no email address to send a code to. Please contact us to change your payout details.', 409);
  if (await locked(userId, purpose)) throw new CodeError('LOCKED', 'Too many incorrect codes. Please wait an hour and try again.', 429);
  if (await n(`SELECT count(*)::int n FROM account_verification_codes WHERE user_id = $1 AND purpose = $2 AND created_at > now() - interval '30 minutes'`,
    [userId, purpose]) >= SENDS_PER_30) {
    throw new CodeError('RATE_LIMITED', 'Too many codes requested. Please wait a few minutes and try again.', 429);
  }
  await db.query(`UPDATE account_verification_codes SET status = 'superseded' WHERE user_id = $1 AND purpose = $2 AND status = 'sent'`, [userId, purpose]);
  const id = crypto.randomUUID();
  const code = generate();
  const masked = maskEmail(to);
  await db.query(`INSERT INTO account_verification_codes (id, user_id, purpose, code_hash, sent_to, status, max_attempts, expires_at)
    VALUES ($1, $2, $3, $4, $5, 'sent', $6, now() + interval '${TTL_MIN} minutes')`, [id, userId, purpose, code6.hash(id, code), masked, MAX_ATTEMPTS]);
  try {
    const mail = deps.emailService || require('./emailService');
    const company = require('../lib/companyContact');
    await mail.sendEmail({ to, subject: 'Your Advantage.Bid verification code',
      text: 'Your Advantage.Bid verification code is ' + code + '.\n\nUse it to ' + PURPOSE_TEXT[purpose] + '. It expires in ' + TTL_MIN
        + ' minutes and works once.\n\nIf you did not ask for this code, do not share it with anyone. Contact us right away at '
        + company.SUPPORT_EMAIL + ' or ' + company.PHONE_DISPLAY + '.\n\n' + company.emailContactLines() });
  } catch (e) {
    await db.query(`UPDATE account_verification_codes SET status = 'send_failed' WHERE id = $1`, [id]).catch(() => {});
    console.error('[account-code] send failed:', e.message);
    throw new CodeError('SEND_FAILED', 'We could not send a code right now. Please try again.', 502);
  }
  await writeAuditLog({ event_type: 'account.verification_code_sent', entity_type: 'user', entity_id: userId, actor_id: userId,
    metadata: { purpose, sent_to: masked } }).catch(() => {});
  return { sent: true, sent_to: masked, expires_in_minutes: TTL_MIN };
}

/** Use a code once. Throws CodeError (VERIFICATION_CODE_REQUIRED / _INCORRECT / _EXPIRED / TOO_MANY_ATTEMPTS / LOCKED). */
async function consume(userId, purpose, code) {
  checkPurpose(purpose);
  if (!code || !String(code).trim()) {
    throw new CodeError('VERIFICATION_CODE_REQUIRED', 'We need to confirm it is you. Request a code by email, then enter it here.', 403, { verification: 'email_code' });
  }
  if (await locked(userId, purpose)) throw new CodeError('LOCKED', 'Too many incorrect codes. Please wait an hour and try again.', 429);
  const v = (await db.query(`SELECT * FROM account_verification_codes WHERE user_id = $1 AND purpose = $2 AND status = 'sent'
    ORDER BY created_at DESC LIMIT 1`, [userId, purpose])).rows[0];
  if (!v) throw new CodeError('VERIFICATION_CODE_REQUIRED', 'Request a new code first.', 403, { verification: 'email_code' });
  if (new Date(v.expires_at) <= new Date()) {
    await db.query(`UPDATE account_verification_codes SET status = 'expired' WHERE id = $1 AND status = 'sent'`, [v.id]);
    throw new CodeError('VERIFICATION_CODE_EXPIRED', 'That code has expired. Request a new one.', 403, { verification: 'email_code' });
  }
  // Count the attempt FIRST, atomically, so parallel guesses can never exceed the limit.
  const counted = (await db.query(`UPDATE account_verification_codes SET attempts = attempts + 1
    WHERE id = $1 AND status = 'sent' AND attempts < max_attempts RETURNING attempts, max_attempts`, [v.id])).rows[0];
  if (!counted) throw new CodeError('TOO_MANY_ATTEMPTS', 'Too many incorrect codes. Request a new code.', 403, { verification: 'email_code' });
  if (!matches(v.code_hash, v.id, String(code).trim())) {
    const exhausted = counted.attempts >= counted.max_attempts;
    if (exhausted) await db.query(`UPDATE account_verification_codes SET status = 'failed' WHERE id = $1 AND status = 'sent'`, [v.id]);
    await writeAuditLog({ event_type: 'account.verification_code_failed', entity_type: 'user', entity_id: userId, actor_id: userId,
      metadata: { purpose, exhausted } }).catch(() => {});
    throw new CodeError(exhausted ? 'TOO_MANY_ATTEMPTS' : 'VERIFICATION_CODE_INCORRECT',
      exhausted ? 'Too many incorrect codes. Request a new code.' : 'That code is not correct.', 403,
      { verification: 'email_code', attempts_left: Math.max(0, counted.max_attempts - counted.attempts) });
  }
  // Single use: only a 'sent' row can be used, and using it consumes it.
  const claimed = await db.query(`UPDATE account_verification_codes SET status = 'used', used_at = now() WHERE id = $1 AND status = 'sent' RETURNING id`, [v.id]);
  if (!claimed.rowCount) throw new CodeError('VERIFICATION_CODE_REQUIRED', 'Request a new code first.', 403, { verification: 'email_code' });
  await writeAuditLog({ event_type: 'account.verification_code_used', entity_type: 'user', entity_id: userId, actor_id: userId, metadata: { purpose } }).catch(() => {});
  return true;
}

// Before migration 220 is applied the code table does not exist: refuse clearly (fail closed, never let the change through).
function unavailable(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (e) {
      if (e && e.code === '42P01') throw new CodeError('NOT_AVAILABLE', 'Email codes are not available right now, so this change cannot be made yet. Please contact us.', 503, { verification: 'email_code' });
      throw e;
    }
  };
}

module.exports = { PURPOSES, CodeError, send: unavailable(send), consume: unavailable(consume), maskEmail, LIMITS: { TTL_MIN, MAX_ATTEMPTS, SENDS_PER_30, LOCK_MIN, LOCK_AFTER_FAILED } };
