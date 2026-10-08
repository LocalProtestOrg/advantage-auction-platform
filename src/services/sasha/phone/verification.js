'use strict';

/**
 * Phone caller verification and the verified phone-support session.
 *
 *   caller identifies an account (its email address, or its verified phone number)
 *   → the SAME reply whatever happened (never reveals whether an account exists, how it can be reached, or a lock)
 *   → a 4-digit code to contact details ALREADY ON THE ACCOUNT, chosen by Railway:
 *       A. a usable VERIFIED mobile number → text message
 *       B. no usable verified number       → email to the account's email address
 *       C. the number is shared / ambiguous → never used to identify or verify; the email path applies
 *       D. a destination the caller supplies is never used (no "send it to this new number/email")
 *   → the caller reads (or keys in) the code; Railway checks it (the model never sees it; it is never stored)
 *   → a short-lived session bound to this call and this account; Sasha's account tools work only inside it.
 *
 * Caller ID is never identity. Authentication is not authorization: every tool still applies its own rules.
 *
 * 4-digit controls: code expires in 5 minutes, 3 wrong entries per code, single use, 3 codes per account per 30 minutes,
 * an hour's lock after two exhausted codes, 3 verification starts per call, 5 starts per identifier per hour,
 * 6 starts per caller number per hour. A number changed in the last 24 hours is not used (email instead).
 *
 * Providers: local_test (simulations/tests; code to the simulated handset), twilio_verify (real calls, when enabled),
 * email_code (code generated here, emailed with existing email infrastructure; simulations use a simulated mailbox).
 */

const crypto = require('crypto');
const db = require('../../../db');
const phoneSettings = require('./phoneSettings');
const audit = require('./phoneAudit');
const code4 = require('../../../lib/verificationCode');
const { normalizeUsPhone, last4, identifierHash } = require('../../../lib/phoneNumber');

const GENERIC_REPLY = 'If that matches an Advantage.Bid account, a 4-digit code has just been sent to the contact details already on that account '
  + '(a text to its verified mobile number, or otherwise an email to its email address). Ask the caller to read the code to you when it arrives. '
  + 'Do not say whether an account was found or which way the code was sent. If nothing arrives within a couple of minutes, offer to try with the '
  + 'account email address, or to take a message for the team.';
const MAX_STARTS_PER_CALL = 3;
const MAX_STARTS_PER_IDENTIFIER_PER_HOUR = 5;
const MAX_STARTS_PER_CALLER_PER_HOUR = 6;
const CHANGED_NUMBER_HOLD_HOURS = 24;
const PENDING = ['sent', 'no_match', 'no_phone', 'ambiguous', 'locked', 'send_failed'];

// ── Twilio Verify (real calls and the website flow; never used by simulations) ─────────────────────────
const twilioVerify = {
  async start(to, deps = {}) {
    const sid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!sid || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) throw new Error('Twilio Verify is not configured');
    const r = await twilioPost(`https://verify.twilio.com/v2/Services/${sid}/Verifications`, { To: to, Channel: 'sms' }, deps);
    return { ref: r.sid || null };
  },
  async check(to, code, deps = {}) {
    const sid = process.env.TWILIO_VERIFY_SERVICE_SID;
    const r = await twilioPost(`https://verify.twilio.com/v2/Services/${sid}/VerificationCheck`, { To: to, Code: code }, deps);
    return r.status === 'approved';
  },
};
async function twilioPost(url, form, deps) {
  const f = deps.fetch || globalThis.fetch;
  const auth = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
  const res = await f(url, { method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Twilio Verify ' + res.status + (j && j.code ? ' ' + j.code : ''));
  return j;
}

/** SMS provider for a call. A simulated call can only ever use the local test provider. */
async function providerFor(call) {
  if (call.is_simulated) return 'local_test';
  const s = await phoneSettings.load();
  return s.enabled && s.verify_provider === 'twilio_verify' ? 'twilio_verify' : 'none';
}

// ── lookup (internal; never revealed to the caller) ─────────────────────────────────────────────────────
const VERIFIED = `(u.phone_verified_at IS NOT NULL AND u.phone_verified_e164 IS NOT NULL AND u.phone = u.phone_verified_e164)`;

/** Find the account. By email: exact match. By phone: only a VERIFIED number held by exactly one active account. */
async function findAccount({ email, phone }, runner = db) {
  if (email) {
    const e = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { status: 'no_match' };
    const rows = (await runner.query(`SELECT id, email, phone, phone_verified_at, phone_verified_e164, phone_changed_at FROM users
      WHERE lower(email) = $1 AND COALESCE(is_active, true) = true`, [e])).rows;
    return rows.length === 1 ? { status: 'found', user: rows[0], by: 'email' } : { status: 'no_match' };
  }
  const n = normalizeUsPhone(phone);
  if (n.status !== 'ok') return { status: 'no_match' };
  const rows = (await runner.query(`SELECT u.id, u.email, u.phone, u.phone_verified_at, u.phone_verified_e164, u.phone_changed_at FROM users u
    WHERE COALESCE(u.is_active, true) = true AND ${VERIFIED} AND u.phone_verified_e164 = $1`, [n.e164])).rows;
  if (rows.length > 1) return { status: 'ambiguous' };
  return rows.length === 1 ? { status: 'found', user: rows[0], by: 'phone' } : { status: 'no_match' };
}

/** Can a code be texted to this account's phone? Verified, not shared with another active account, not just changed. */
async function smsUsable(user, runner = db) {
  if (!require('../../accountPhoneService').isVerified(user)) return false;
  if (user.phone_changed_at && Date.now() - new Date(user.phone_changed_at).getTime() < CHANGED_NUMBER_HOLD_HOURS * 3600000) return false;
  const shared = Number((await runner.query(`SELECT count(*)::int n FROM users u WHERE u.id <> $1 AND COALESCE(u.is_active, true) = true
    AND ${VERIFIED} AND u.phone_verified_e164 = $2`, [user.id, user.phone_verified_e164])).rows[0].n);
  return shared === 0;
}

/**
 * Start verification. Always returns { reply: GENERIC_REPLY } for the model; status/method are internal (logs/tests).
 * opts.prefer: 'email' to use the account email even when a verified number exists (the caller asks for it).
 * deps.onTestCode(code, { channel, last4, email }): local test codes in simulations (simulated handset / mailbox).
 */
async function start(call, { email = null, phone = null, prefer = null } = {}, deps = {}) {
  const s = await phoneSettings.load();
  if (!email && !phone) return { reply: 'Ask the caller for the email address or the verified mobile number on their Advantage.Bid account.', status: 'missing_identifier' };
  const identifierType = email ? 'email' : 'phone';
  const idHash = identifierHash(email ? String(email).trim().toLowerCase() : (normalizeUsPhone(phone).e164 || String(phone || '')));
  const expiresAt = new Date(Date.now() + s.code_ttl_minutes * 60000);
  const finish = async (status, extra = {}) => {
    await db.query(`UPDATE cs_phone_verifications SET status = 'superseded' WHERE call_id = $1 AND status = ANY($2::text[])`, [call.id, PENDING]);
    const id = extra.id || crypto.randomUUID();
    await db.query(`INSERT INTO cs_phone_verifications (id, call_id, target_user_id, identifier_type, identifier_hash, caller_number_hash, provider, provider_ref,
        code_hash, destination_last4, channel, status, max_attempts, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, call.id, extra.userId || null, identifierType, idHash, call.caller_number_hash || null, extra.provider || 'none', extra.ref || null, extra.codeHash || null,
      extra.last4 || null, extra.channel || 'sms', status, s.code_max_attempts, expiresAt]);
    await db.query(`UPDATE cs_calls SET verification_state = CASE WHEN verification_state = 'verified' THEN verification_state ELSE 'code_sent' END WHERE id = $1`, [call.id]);
    await audit.record(call, 'verification_started', { accountUserId: extra.userId || null,
      detail: { identifier_type: identifierType, outcome: status, provider: extra.provider || 'none', what: extra.channel || null, destination_last4: extra.last4 || null } });
    return { reply: GENERIC_REPLY, status, method: extra.channel || null, verificationId: id };
  };

  // Throttles (each returns the same generic reply; nothing is sent).
  const n = async (sql, p) => Number((await db.query(sql, p)).rows[0].n);
  if (await n(`SELECT count(*)::int n FROM cs_phone_verifications WHERE call_id = $1`, [call.id]) >= MAX_STARTS_PER_CALL) {
    await audit.record(call, 'verification_locked', { detail: { reason: 'too many verification starts on this call' } });
    return { reply: 'Verification is not available again on this call. Offer to take a message for the team.', status: 'call_limit' };
  }
  if (await n(`SELECT count(*)::int n FROM cs_phone_verifications WHERE identifier_hash = $1 AND created_at > now() - interval '1 hour'`, [idHash]) >= MAX_STARTS_PER_IDENTIFIER_PER_HOUR) return finish('locked');
  if (call.caller_number_hash && await n(`SELECT count(*)::int n FROM cs_phone_verifications WHERE caller_number_hash = $1 AND created_at > now() - interval '1 hour'`,
    [call.caller_number_hash]) >= MAX_STARTS_PER_CALLER_PER_HOUR) return finish('locked');

  const found = await findAccount({ email, phone });
  if (found.status !== 'found') return finish(found.status);
  const user = found.user;
  if (await n(`SELECT count(*)::int n FROM cs_phone_verifications WHERE target_user_id = $1 AND status = 'failed'
    AND created_at > now() - ($2 || ' minutes')::interval`, [user.id, String(s.lockout_minutes)]) >= 2) return finish('locked', { userId: user.id });
  if (await n(`SELECT count(*)::int n FROM cs_phone_verifications WHERE target_user_id = $1 AND status IN ('sent','approved','failed','expired','superseded')
    AND provider <> 'none' AND created_at > now() - interval '30 minutes'`, [user.id]) >= s.code_max_sends_per_30min) return finish('locked', { userId: user.id });

  // Choose the destination from what is ALREADY on the account.
  const viaSms = prefer !== 'email' && await smsUsable(user);
  const id = crypto.randomUUID();
  if (viaSms) {
    const provider = await providerFor(call);
    const dest = user.phone_verified_e164;
    if (provider === 'local_test') {
      const code = code4.generate();
      const r = await finish('sent', { id, userId: user.id, provider, channel: 'sms', last4: last4(dest), codeHash: code4.hash(id, code) });
      if (typeof deps.onTestCode === 'function') deps.onTestCode(code, { channel: 'sms', last4: last4(dest) });
      return r;
    }
    if (provider === 'twilio_verify') {
      try { const sent = await twilioVerify.start(dest, deps); return finish('sent', { id, userId: user.id, provider, channel: 'sms', last4: last4(dest), ref: sent.ref }); }
      catch (e) { console.error('[sasha-phone] verify send failed', e.message); /* fall through to email */ }
    }
  }
  // Email to the account's existing address (fallback, or the only option).
  if (!user.email) return finish('no_phone', { userId: user.id });
  const code = code4.generate();
  const codeHash = code4.hash(id, code);
  if (call.is_simulated) {
    const r = await finish('sent', { id, userId: user.id, provider: 'email_code', channel: 'email', codeHash });
    if (typeof deps.onTestCode === 'function') deps.onTestCode(code, { channel: 'email', email: user.email });
    return r;
  }
  if (!(await phoneSettings.liveCallsAllowed())) return finish('send_failed', { id, userId: user.id, provider: 'email_code', channel: 'email' });
  try {
    const r = await (deps.emailService || require('../../emailService')).sendEmail({ to: user.email, subject: 'Your Advantage.Bid verification code',
      text: `Your Advantage.Bid verification code is ${code}. It expires in ${s.code_ttl_minutes} minutes. Read it to Sasha on your call. If you did not call Advantage.Bid, you can ignore this email.` });
    if (r && r.skipped) throw new Error('email not configured');
    return finish('sent', { id, userId: user.id, provider: 'email_code', channel: 'email', codeHash });
  } catch (e) {
    console.error('[sasha-phone] verification email failed', e.message);
    return finish('send_failed', { id, userId: user.id, provider: 'email_code', channel: 'email' });
  }
}

/**
 * Check a code the caller read (extracted server-side; never passed through the model).
 * Returns { ok, attemptsLeft, reason, session? }. A wrong code and "nothing was ever sent" look identical.
 * Single use: an approved code is consumed and can never be accepted again.
 */
async function check(call, code, deps = {}) {
  const v = (await db.query(`SELECT * FROM cs_phone_verifications WHERE call_id = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
    [call.id, PENDING])).rows[0];
  if (!v) return { ok: false, reason: 'no_code_requested', attemptsLeft: 0 };
  if (new Date(v.expires_at) <= new Date()) {
    await db.query(`UPDATE cs_phone_verifications SET status = 'expired' WHERE id = $1`, [v.id]);
    await audit.record(call, 'verification_failed', { accountUserId: v.target_user_id, detail: { reason: 'code expired' } });
    return { ok: false, reason: 'expired', attemptsLeft: 0 };
  }
  const attempts = v.attempts + 1;
  let correct = false;
  if (v.status === 'sent' && code4.CODE_RE.test(String(code || ''))) {
    if (v.provider === 'local_test' || v.provider === 'email_code') correct = code4.matches(v.code_hash, v.id, code);
    else if (v.provider === 'twilio_verify') {
      const u = (await db.query(`SELECT phone_verified_e164 FROM users WHERE id = $1`, [v.target_user_id])).rows[0];
      try { correct = await twilioVerify.check(u && u.phone_verified_e164, code, deps); } catch (e) { correct = false; }
    }
  }
  if (correct) {
    const claimed = await db.query(`UPDATE cs_phone_verifications SET status = 'approved', attempts = $2, verified_at = now() WHERE id = $1 AND status = 'sent' RETURNING id`, [v.id, attempts]);
    if (!claimed.rowCount) return { ok: false, reason: 'no_code_requested', attemptsLeft: 0 };
    const s = await phoneSettings.load();
    const session = (await db.query(`INSERT INTO cs_phone_sessions (call_id, conversation_id, user_id, verification_id, expires_at)
      VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval) RETURNING *`, [call.id, call.conversation_id, v.target_user_id, v.id, String(s.session_max_minutes)])).rows[0];
    await db.query(`UPDATE cs_calls SET verification_state = 'verified', verified_user_id = $2 WHERE id = $1`, [call.id, v.target_user_id]);
    await audit.record(call, 'verification_succeeded', { accountUserId: v.target_user_id, sessionId: session.id, detail: { provider: v.provider, what: v.channel } });
    await audit.record(call, 'session_started', { accountUserId: v.target_user_id, sessionId: session.id, detail: { level: session.level, what: v.channel, expires_at: session.expires_at.toISOString() } });
    return { ok: true, session, method: v.channel };
  }
  const exhausted = attempts >= v.max_attempts;
  await db.query(`UPDATE cs_phone_verifications SET attempts = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END WHERE id = $1`, [v.id, attempts, exhausted]);
  await audit.record(call, exhausted ? 'verification_locked' : 'verification_failed', { accountUserId: v.target_user_id,
    detail: { attempts_left: Math.max(0, v.max_attempts - attempts), reason: exhausted ? 'too many wrong codes' : 'wrong code' } });
  return { ok: false, reason: exhausted ? 'too_many_attempts' : 'wrong_code', attemptsLeft: Math.max(0, v.max_attempts - attempts) };
}

/** The live session for this call, or null. Ends it (and says so) when it has expired. */
async function activeSession(call) {
  const s = (await db.query(`SELECT * FROM cs_phone_sessions WHERE call_id = $1 AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`, [call.id])).rows[0];
  if (!s) return null;
  if (new Date(s.expires_at) <= new Date()) { await endSession(call, 'expired'); return null; }
  return s;
}

async function endSession(call, reason) {
  const r = await db.query(`UPDATE cs_phone_sessions SET ended_at = now(), end_reason = $2 WHERE call_id = $1 AND ended_at IS NULL RETURNING id, user_id`, [call.id, reason]);
  for (const s of r.rows) await audit.record(call, 'session_ended', { accountUserId: s.user_id, sessionId: s.id, detail: { end_reason: reason } });
  if (r.rowCount && reason === 'expired') await db.query(`UPDATE cs_calls SET verification_state = 'expired' WHERE id = $1`, [call.id]);
  return r.rowCount;
}

module.exports = { start, check, activeSession, endSession, findAccount, smsUsable, providerFor, GENERIC_REPLY, MAX_STARTS_PER_CALL,
  MAX_STARTS_PER_CALLER_PER_HOUR, _twilioVerify: twilioVerify };
