'use strict';

/**
 * Step-up verification for financially sensitive and staff-changing seller actions (migration 199; owner-approved design
 * docs/projects/seller-staff-permissions-design-2026-10-16.md §4).
 *
 *   start(ctx, { password }, { sid })   company OWNER only → confirms the account password → sends a one-time 4-digit code
 *                                       to the owner's VERIFIED phone (same sender as website phone verification)
 *   confirm(ctx, { code }, { sid })     → approves the challenge for THIS sign-in session for GRANT_MIN minutes
 *   isFresh(userId, sid)                → is there an approved, unexpired step-up for this person and session?
 *
 * Fails closed: no verified phone, no code sender, or no session id → the sensitive action is refused. Codes are never
 * stored (HMAC or the provider's reference only). Controls: 5-minute codes, 3 attempts each, 3 codes per 30 minutes,
 * one-hour lockout after two exhausted codes, single use.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const code4 = require('../lib/verificationCode');
const { last4 } = require('../lib/phoneNumber');
const phone = require('./accountPhoneService');
const { writeAuditLog } = require('../lib/auditLog');

const TTL_MIN = 5; const MAX_ATTEMPTS = 3; const SENDS_PER_30 = 3; const LOCK_MIN = 60; const GRANT_MIN = 10;

class StepUpError extends Error { constructor(code, message, status = 403, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); } }

function ownerOnly(ctx) {
  if (!ctx || !ctx.sellerId || ctx.role !== 'owner' || ctx.staff) throw new StepUpError('OWNER_ONLY', 'Only the company owner can do this.');
}

async function start(ctx, { password } = {}, { sid } = {}, deps = {}) {
  ownerOnly(ctx);
  if (!sid) throw new StepUpError('SIGN_IN_AGAIN', 'Please sign out and sign in again, then retry.', 401);
  const u = (await db.query(`SELECT id, password_hash, phone, phone_verified_at, phone_verified_e164, COALESCE(is_active, true) active FROM users WHERE id = $1`, [ctx.userId])).rows[0];
  if (!u || !u.active) throw new StepUpError('NO_USER', 'Account not available.');
  if (!u.password_hash || !password || !(await bcrypt.compare(String(password), u.password_hash))) {
    await writeAuditLog({ event_type: 'seller.step_up_password_failed', entity_type: 'user', entity_id: ctx.userId, actor_id: ctx.userId,
      metadata: { seller_id: ctx.sellerId } }).catch(() => {});
    throw new StepUpError('PASSWORD_INCORRECT', 'That password is not correct.');
  }
  if (!phone.isVerified(u)) throw new StepUpError('PHONE_NOT_VERIFIED', 'Verify your mobile number on your account page first. We send a code to it for this step.', 409);
  const snd = await phone.sender(deps);
  if (!snd) throw new StepUpError('NOT_AVAILABLE', 'Phone codes are not available right now, so this change cannot be made yet. Please try again later.', 503);
  const n = async (sql, p) => Number((await db.query(sql, p)).rows[0].n);
  if (await n(`SELECT coalesce(sum(attempts), 0)::int n FROM seller_step_up_challenges WHERE user_id = $1 AND status <> 'approved' AND created_at > now() - interval '${LOCK_MIN} minutes'`, [ctx.userId]) >= 2 * MAX_ATTEMPTS) {
    throw new StepUpError('LOCKED', 'Too many incorrect codes. Please wait an hour and try again.', 429);
  }
  if (await n(`SELECT count(*)::int n FROM seller_step_up_challenges WHERE user_id = $1 AND created_at > now() - interval '30 minutes'`, [ctx.userId]) >= SENDS_PER_30) {
    throw new StepUpError('RATE_LIMITED', 'Too many codes requested. Please wait a few minutes and try again.', 429);
  }
  await db.query(`UPDATE seller_step_up_challenges SET status = 'superseded' WHERE user_id = $1 AND status = 'sent'`, [ctx.userId]);
  const id = crypto.randomUUID();
  const e164 = u.phone_verified_e164;
  let ref = null; let codeHash = null; let status = 'sent';
  try {
    if (snd.local) { const c = code4.generate(); codeHash = code4.hash(id, c); await snd.deliver(e164, c); }
    else ref = (await snd.start(e164, deps)).ref;
  } catch (e) { status = 'send_failed'; console.error('[seller-step-up] send failed', e.message); }
  await db.query(
    `INSERT INTO seller_step_up_challenges (id, user_id, seller_id, session_sid, phone_last4, provider, provider_ref, code_hash, status, max_attempts, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '${TTL_MIN} minutes')`,
    [id, ctx.userId, ctx.sellerId, String(sid), last4(e164), snd.local ? 'local_test' : 'twilio_verify', ref, codeHash, status, MAX_ATTEMPTS]);
  if (status !== 'sent') throw new StepUpError('SEND_FAILED', 'We could not send a code to your phone. Please try again.', 502);
  return { sent: true, phone_last4: last4(e164), expires_in_minutes: TTL_MIN };
}

async function confirm(ctx, { code } = {}, { sid } = {}, deps = {}) {
  ownerOnly(ctx);
  if (!sid) throw new StepUpError('SIGN_IN_AGAIN', 'Please sign out and sign in again, then retry.', 401);
  const v = (await db.query(`SELECT * FROM seller_step_up_challenges WHERE user_id = $1 AND session_sid = $2 AND status = 'sent' ORDER BY created_at DESC LIMIT 1`,
    [ctx.userId, String(sid)])).rows[0];
  if (!v) throw new StepUpError('NO_CODE', 'Request a new code first.', 400);
  if (new Date(v.expires_at) <= new Date()) {
    await db.query(`UPDATE seller_step_up_challenges SET status = 'expired' WHERE id = $1`, [v.id]);
    throw new StepUpError('EXPIRED', 'That code has expired. Request a new one.', 400);
  }
  const attempts = v.attempts + 1;
  let ok = false;
  if (code4.CODE_RE.test(String(code || ''))) {
    if (v.provider === 'local_test') ok = code4.matches(v.code_hash, v.id, code);
    else {
      const u = (await db.query('SELECT phone_verified_e164 FROM users WHERE id = $1', [ctx.userId])).rows[0];
      try { ok = await require('./sasha/phone/verification')._twilioVerify.check(u.phone_verified_e164, String(code), deps); } catch (_e) { ok = false; }
    }
  }
  if (!ok) {
    const exhausted = attempts >= v.max_attempts;
    await db.query(`UPDATE seller_step_up_challenges SET attempts = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END WHERE id = $1`, [v.id, attempts, exhausted]);
    throw new StepUpError(exhausted ? 'TOO_MANY_ATTEMPTS' : 'WRONG_CODE', exhausted ? 'Too many incorrect codes. Request a new code.' : 'That code is not correct.', 400,
      { attempts_left: Math.max(0, v.max_attempts - attempts) });
  }
  const claimed = await db.query(
    `UPDATE seller_step_up_challenges SET status = 'approved', attempts = $2, approved_at = now(), granted_until = now() + interval '${GRANT_MIN} minutes'
      WHERE id = $1 AND status = 'sent' RETURNING granted_until`, [v.id, attempts]);
  if (!claimed.rowCount) throw new StepUpError('NO_CODE', 'Request a new code first.', 400);
  await writeAuditLog({ event_type: 'seller.step_up_verified', entity_type: 'seller_profile', entity_id: ctx.sellerId, actor_id: ctx.userId, metadata: {} }).catch(() => {});
  return { verified: true, valid_until: claimed.rows[0].granted_until };
}

async function isFresh(userId, sid, runner = db) {
  if (!userId || !sid) return false;
  const r = await runner.query(
    `SELECT 1 FROM seller_step_up_challenges WHERE user_id = $1 AND session_sid = $2 AND status = 'approved' AND granted_until > now() LIMIT 1`,
    [userId, String(sid)]);
  return r.rowCount > 0;
}

// Route guard: after requireSellerPermission. Refuses unless this owner verified with password + phone code in THIS session
// within the last GRANT_MIN minutes.
function requireStepUp() {
  return async (req, res, next) => {
    try {
      const ctx = req.sellerCtx;
      if (!ctx || ctx.role !== 'owner' || ctx.staff) return res.status(403).json({ success: false, code: 'OWNER_ONLY', message: 'Only the company owner can do this.' });
      if (!(await isFresh(ctx.userId, req.session && req.session.sid))) {
        return res.status(403).json({ success: false, code: 'STEP_UP_REQUIRED', message: 'Confirm it is you: enter your password and the code we text to your phone.' });
      }
      return next();
    } catch (e) {
      console.error('[seller-step-up] check failed:', e.message);
      return res.status(500).json({ success: false, message: 'Verification check failed.' });
    }
  };
}

module.exports = { start, confirm, isFresh, requireStepUp, StepUpError, LIMITS: { TTL_MIN, MAX_ATTEMPTS, SENDS_PER_30, LOCK_MIN, GRANT_MIN } };
