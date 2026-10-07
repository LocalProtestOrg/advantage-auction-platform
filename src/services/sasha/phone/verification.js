'use strict';

/**
 * Phone caller verification and the verified phone-support session.
 *
 *   caller identifies an account (email or the account's phone number)
 *   → the SAME reply whatever happened (never reveals whether an account exists, has a phone, or is locked)
 *   → a 6-digit code to the phone ON FILE for that account (never to the number the caller is calling from)
 *   → the caller reads the code; Railway checks it (the model never sees the code)
 *   → a short-lived session bound to this call and this account; Sasha's account tools work only inside it.
 *
 * Caller ID is never identity. Authentication is not authorization: every tool still applies its own rules.
 *
 * Providers:
 *   local_test     simulations and automated tests only. The code goes to a callback (the Super Admin tester's
 *                  simulated handset); only a salted hash is stored. Never used for a real call.
 *   twilio_verify  real calls, when sasha.phone.verify_provider = 'twilio_verify' AND the phone channel is on.
 *                  Twilio generates, delivers and checks the code. Not enabled in this release.
 *
 * Limits (sasha.phone.*): code lifetime, wrong entries per code, codes per account per 30 minutes, lock after two
 * exhausted codes, 3 verification starts per call, 5 starts per identifier per hour, session length.
 */

const crypto = require('crypto');
const db = require('../../../db');
const phoneSettings = require('./phoneSettings');
const audit = require('./phoneAudit');
const { normalizeUsPhone, digitForms, last4, identifierHash } = require('../../../lib/phoneNumber');

const GENERIC_REPLY = 'If that matches an Advantage.Bid account with a mobile number on file, a 6-digit code has just been texted to that number. '
  + 'Ask the caller to read the code to you when it arrives. Do not say whether an account was found. If no code arrives within a couple of minutes, '
  + 'offer a callback from the team instead.';
const MAX_STARTS_PER_CALL = 3;
const MAX_STARTS_PER_IDENTIFIER_PER_HOUR = 5;
const PENDING = ['sent', 'no_match', 'no_phone', 'ambiguous', 'locked', 'send_failed'];

const codeHash = (verificationId, code) => crypto.createHmac('sha256', process.env.SASHA_PHONE_HASH_SALT || ('sasha-code:' + (process.env.JWT_SECRET || 'dev')))
  .update(verificationId + ':' + code).digest('hex');
const sameHash = (a, b) => { try { return a && b && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch (_e) { return false; } };

// ── providers ─────────────────────────────────────────────────────────────────────────────────────────
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

/** Which provider a call may use. A simulated call can only ever use the local test provider. */
async function providerFor(call) {
  if (call.is_simulated) return 'local_test';
  const s = await phoneSettings.load();
  return s.enabled && s.verify_provider === 'twilio_verify' ? 'twilio_verify' : 'none';
}

// ── lookup (internal; the result is never revealed to the caller) ─────────────────────────────────────────
async function findAccount({ email, phone }, runner = db) {
  if (email) {
    const e = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { status: 'no_match' };
    const rows = (await runner.query(`SELECT id, phone FROM users WHERE lower(email) = $1 AND COALESCE(is_active, true) = true`, [e])).rows;
    return rows.length === 1 ? { status: 'found', user: rows[0] } : { status: 'no_match' };
  }
  const n = normalizeUsPhone(phone);
  if (n.status !== 'ok') return { status: 'no_match' };
  const forms = digitForms(n.e164);
  const rows = (await runner.query(`SELECT id, phone FROM users WHERE COALESCE(is_active, true) = true
    AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ANY($1::text[])`, [forms])).rows
    .filter((u) => normalizeUsPhone(u.phone).e164 === n.e164);
  if (rows.length > 1) return { status: 'ambiguous' };
  return rows.length === 1 ? { status: 'found', user: rows[0] } : { status: 'no_match' };
}

/**
 * Start verification. Always returns { reply: GENERIC_REPLY } for the model; the internal status is for logs/tests.
 * deps.onTestCode(code, destinationLast4): local_test provider only (simulated handset).
 */
async function start(call, { email = null, phone = null } = {}, deps = {}) {
  const s = await phoneSettings.load();
  const identifierType = email ? 'email' : 'phone';
  const idHash = identifierHash(email ? String(email).trim().toLowerCase() : (normalizeUsPhone(phone).e164 || String(phone || '')));
  const provider = await providerFor(call);
  const expiresAt = new Date(Date.now() + s.code_ttl_minutes * 60000);
  const insert = async (status, extra = {}) => (await db.query(
    `INSERT INTO cs_phone_verifications (call_id, target_user_id, identifier_type, identifier_hash, provider, provider_ref, code_hash, destination_last4,
       status, max_attempts, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [call.id, extra.userId || null, identifierType, idHash, provider, extra.ref || null, null, extra.last4 || null, status, s.code_max_attempts, expiresAt])).rows[0].id;
  const finish = async (status, extra = {}) => {
    await db.query(`UPDATE cs_phone_verifications SET status = 'superseded' WHERE call_id = $1 AND status = ANY($2::text[])`, [call.id, PENDING]);
    const id = await insert(status, extra);
    await db.query(`UPDATE cs_calls SET verification_state = CASE WHEN verification_state = 'verified' THEN verification_state ELSE 'code_sent' END WHERE id = $1`, [call.id]);
    await audit.record(call, 'verification_started', { accountUserId: extra.userId || null,
      detail: { identifier_type: identifierType, outcome: status, provider, destination_last4: extra.last4 || null } });
    return { reply: GENERIC_REPLY, status, verificationId: id };
  };

  if (!email && !phone) return { reply: 'Ask the caller for the email address or the phone number on their Advantage.Bid account.', status: 'missing_identifier' };
  const starts = Number((await db.query(`SELECT count(*)::int n FROM cs_phone_verifications WHERE call_id = $1`, [call.id])).rows[0].n);
  if (starts >= MAX_STARTS_PER_CALL) {
    await audit.record(call, 'verification_locked', { detail: { reason: 'too many verification starts on this call' } });
    return { reply: 'Verification is not available again on this call. Offer a callback from the team.', status: 'call_limit' };
  }
  const recentForIdentifier = Number((await db.query(`SELECT count(*)::int n FROM cs_phone_verifications WHERE identifier_hash = $1
    AND created_at > now() - interval '1 hour'`, [idHash])).rows[0].n);
  if (recentForIdentifier >= MAX_STARTS_PER_IDENTIFIER_PER_HOUR) return finish('locked');

  const found = await findAccount({ email, phone });
  if (found.status !== 'found') return finish(found.status);
  const user = found.user;
  const failures = Number((await db.query(`SELECT count(*)::int n FROM cs_phone_verifications WHERE target_user_id = $1 AND status = 'failed'
    AND created_at > now() - ($2 || ' minutes')::interval`, [user.id, String(s.lockout_minutes)])).rows[0].n);
  if (failures >= 2) return finish('locked', { userId: user.id });
  const sends = Number((await db.query(`SELECT count(*)::int n FROM cs_phone_verifications WHERE target_user_id = $1 AND status IN ('sent','approved','failed','expired','superseded')
    AND provider <> 'none' AND created_at > now() - interval '30 minutes'`, [user.id])).rows[0].n);
  if (sends >= s.code_max_sends_per_30min) return finish('locked', { userId: user.id });
  const dest = normalizeUsPhone(user.phone);
  if (dest.status !== 'ok') return finish('no_phone', { userId: user.id });
  if (provider === 'none') return finish('send_failed', { userId: user.id, last4: last4(dest.e164) });

  // Send. local_test: the code exists only in memory long enough to hash it and hand it to the simulated handset.
  if (provider === 'local_test') {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const r = await finish('sent', { userId: user.id, last4: last4(dest.e164) });
    await db.query(`UPDATE cs_phone_verifications SET code_hash = $2 WHERE id = $1`, [r.verificationId, codeHash(r.verificationId, code)]);
    if (typeof deps.onTestCode === 'function') deps.onTestCode(code, last4(dest.e164));
    return r;
  }
  try {
    const sent = await twilioVerify.start(dest.e164, deps);
    return finish('sent', { userId: user.id, last4: last4(dest.e164), ref: sent.ref });
  } catch (e) {
    console.error('[sasha-phone] verify send failed', e.message);
    return finish('send_failed', { userId: user.id, last4: last4(dest.e164) });
  }
}

/**
 * Check a code the caller read (extracted server-side; never passed through the model).
 * Returns { ok, attemptsLeft, reason, session? }. A wrong code and "nothing was ever sent" look identical.
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
  if (v.status === 'sent' && /^\d{6}$/.test(String(code || ''))) {
    if (v.provider === 'local_test') correct = sameHash(v.code_hash, codeHash(v.id, code));
    else if (v.provider === 'twilio_verify') {
      const u = (await db.query(`SELECT phone FROM users WHERE id = $1`, [v.target_user_id])).rows[0];
      try { correct = await twilioVerify.check(normalizeUsPhone(u && u.phone).e164, code, deps); } catch (e) { correct = false; }
    }
  }
  if (correct) {
    await db.query(`UPDATE cs_phone_verifications SET status = 'approved', attempts = $2, verified_at = now() WHERE id = $1`, [v.id, attempts]);
    const s = await phoneSettings.load();
    const session = (await db.query(`INSERT INTO cs_phone_sessions (call_id, conversation_id, user_id, verification_id, expires_at)
      VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval) RETURNING *`, [call.id, call.conversation_id, v.target_user_id, v.id, String(s.session_max_minutes)])).rows[0];
    await db.query(`UPDATE cs_calls SET verification_state = 'verified', verified_user_id = $2 WHERE id = $1`, [call.id, v.target_user_id]);
    // A simulation proves nothing about the real customer's phone: only a real call marks the number as verified.
    if (!call.is_simulated) await db.query(`UPDATE users SET phone_verified_at = now() WHERE id = $1`, [v.target_user_id]);
    await audit.record(call, 'verification_succeeded', { accountUserId: v.target_user_id, sessionId: session.id, detail: { provider: v.provider } });
    await audit.record(call, 'session_started', { accountUserId: v.target_user_id, sessionId: session.id, detail: { level: session.level, expires_at: session.expires_at.toISOString() } });
    return { ok: true, session };
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

module.exports = { start, check, activeSession, endSession, findAccount, providerFor, GENERIC_REPLY, MAX_STARTS_PER_CALL, _twilioVerify: twilioVerify, _codeHash: codeHash };
