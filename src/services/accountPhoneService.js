'use strict';

/**
 * Verified account phone numbers (migration 189).
 *
 * A phone is VERIFIED only when users.phone_verified_at is set AND users.phone equals users.phone_verified_e164 (the
 * exact number that passed a code). Any later change to users.phone, by any path, therefore un-verifies it. Existing
 * numbers are never marked verified just because they are present.
 *
 * Verification is ACCOUNT SECURITY, not consent: it never opts anyone into texts (see smsConsentService).
 *
 * Website flow (signed-in customer):
 *   start({ phone, currentPassword })  normalize → 4-digit code to THAT number (Twilio Verify when enabled)
 *   confirm({ code })                  → users.phone / phone_verified_e164 / phone_verified_at; audited
 * Changing an already verified number requires the account password and emails a change notice to the account email.
 *
 * Controls: code expiry 5 min, 3 wrong entries per code, 3 codes per account per 30 min, 5 codes per number per hour
 * (across accounts), 10 per IP per hour, lockout for an hour after two exhausted codes, single use.
 *
 * Bidder requirement (bidder_phone.required, OFF until a code sender is live): auction registration requires a verified
 * phone; the bid gate requires it for registrations made after the requirement was turned on (existing registrations
 * are not cut off mid-auction). Enabling it is refused while no code sender is available.
 */

const crypto = require('crypto');
const db = require('../db');
const code4 = require('../lib/verificationCode');
const { normalizeUsPhone, identifierHash, last4 } = require('../lib/phoneNumber');
const { writeAuditLog } = require('../lib/auditLog');

const TTL_MIN = 5; const MAX_ATTEMPTS = 3; const SENDS_PER_30 = 3; const PER_NUMBER_PER_HOUR = 5; const PER_IP_PER_HOUR = 10; const LOCK_MIN = 60;
const VERIFIED_SQL = (a = 'u') => `(${a}.phone_verified_at IS NOT NULL AND ${a}.phone_verified_e164 IS NOT NULL AND ${a}.phone = ${a}.phone_verified_e164)`;

class PhoneError extends Error { constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); } }

async function config(runner = db) {
  const rows = (await runner.query(`SELECT key, value FROM platform_config WHERE key LIKE 'bidder_phone.%'`)).rows;
  const c = { required: false, verification_enabled: false, required_since: null };
  for (const { key, value } of rows) {
    const k = key.slice('bidder_phone.'.length);
    if (k === 'required' || k === 'verification_enabled') c[k] = value === true;
    else if (k === 'required_since' && typeof value === 'string') c.required_since = value;
  }
  return c;
}

/** The code sender for the website flow. Tests inject deps.sender; production uses Twilio Verify once enabled. */
async function sender(deps = {}) {
  if (deps.sender) return deps.sender;
  const c = await config();
  if (c.verification_enabled && process.env.TWILIO_VERIFY_SERVICE_SID && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return require('./sasha/phone/verification')._twilioVerify;   // same Verify service; code length is set on the service (4)
  }
  return null;
}
async function verificationAvailable(deps) { return !!(await sender(deps)); }

function isVerified(u) { return !!(u && u.phone_verified_at && u.phone_verified_e164 && u.phone === u.phone_verified_e164); }

async function status(userId) {
  const u = (await db.query(`SELECT phone, phone_verified_at, phone_verified_e164, phone_changed_at FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u) throw new PhoneError('NO_USER', 'Account not found.', 404);
  const verified = isVerified(u);
  const n = normalizeUsPhone(u.phone);
  return { phone_last4: n.e164 ? last4(n.e164) : null, verified, verified_at: verified ? u.phone_verified_at : null,
    needs_verification: !verified, verification_available: await verificationAvailable(), required_for_bidding: (await config()).required };
}

async function start(userId, { phone, currentPassword = null, ip = null } = {}, deps = {}) {
  const snd = await sender(deps);
  if (!snd) throw new PhoneError('NOT_AVAILABLE', 'Phone verification is not available yet. Please try again later.', 503);
  const n = normalizeUsPhone(phone);
  if (n.status !== 'ok' || (n.fictional && !deps.allowFictional)) throw new PhoneError('INVALID_PHONE', 'Enter a valid US mobile number, including the area code.');
  const u = (await db.query(`SELECT id, phone, password_hash, phone_verified_at, phone_verified_e164, COALESCE(is_active, true) active FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u || !u.active) throw new PhoneError('NO_USER', 'Account not available.', 403);
  if (isVerified(u) && u.phone_verified_e164 === n.e164) return { already_verified: true, phone_last4: last4(n.e164) };
  // Replacing a verified number is a security change: confirm the account password.
  if (isVerified(u) && u.password_hash) {
    if (!currentPassword) throw new PhoneError('PASSWORD_REQUIRED', 'Enter your account password to change your verified phone number.', 403);
    if (!(await require('bcrypt').compare(String(currentPassword), u.password_hash))) throw new PhoneError('PASSWORD_INCORRECT', 'That password is not correct.', 403);
  }
  const phoneHash = identifierHash(n.e164);
  const ipHash = ip ? identifierHash('ip:' + ip) : null;
  const q1 = async (sql, p) => Number((await db.query(sql, p)).rows[0].n);
  if (await q1(`SELECT count(*)::int n FROM account_phone_verifications WHERE user_id = $1 AND status = 'failed' AND created_at > now() - interval '${LOCK_MIN} minutes'`, [userId]) >= 2) {
    throw new PhoneError('LOCKED', 'Too many incorrect codes. Please wait an hour and try again.', 429);
  }
  if (await q1(`SELECT count(*)::int n FROM account_phone_verifications WHERE user_id = $1 AND created_at > now() - interval '30 minutes'`, [userId]) >= SENDS_PER_30
    || await q1(`SELECT count(*)::int n FROM account_phone_verifications WHERE phone_hash = $1 AND created_at > now() - interval '1 hour'`, [phoneHash]) >= PER_NUMBER_PER_HOUR
    || (ipHash && await q1(`SELECT count(*)::int n FROM account_phone_verifications WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'`, [ipHash]) >= PER_IP_PER_HOUR)) {
    throw new PhoneError('RATE_LIMITED', 'Too many codes requested. Please wait a few minutes and try again.', 429);
  }
  await db.query(`UPDATE account_phone_verifications SET status = 'superseded' WHERE user_id = $1 AND status = 'sent'`, [userId]);
  const id = crypto.randomUUID();
  const provider = snd.local ? 'local_test' : 'twilio_verify';
  let ref = null; let codeHash = null; let status = 'sent';
  try {
    if (snd.local) { const c = code4.generate(); codeHash = code4.hash(id, c); await snd.deliver(n.e164, c); }
    else ref = (await snd.start(n.e164, deps)).ref;
  } catch (e) { status = 'send_failed'; console.error('[account-phone] send failed', e.message); }
  await db.query(`INSERT INTO account_phone_verifications (id, user_id, phone_e164, phone_hash, provider, provider_ref, code_hash, status, max_attempts, ip_hash, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '${TTL_MIN} minutes')`, [id, userId, n.e164, phoneHash, provider, ref, codeHash, status, MAX_ATTEMPTS, ipHash]);
  await writeAuditLog({ event_type: 'account.phone_verification_started', entity_type: 'user', entity_id: userId, actor_id: userId,
    metadata: { phone_last4: last4(n.e164), provider, outcome: status } }).catch(() => {});
  if (status !== 'sent') throw new PhoneError('SEND_FAILED', 'We could not send a code to that number. Check it and try again.', 502);
  return { sent: true, phone_last4: last4(n.e164), expires_in_minutes: TTL_MIN };
}

async function confirm(userId, { code } = {}, deps = {}) {
  const v = (await db.query(`SELECT * FROM account_phone_verifications WHERE user_id = $1 AND status = 'sent' ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
  if (!v) throw new PhoneError('NO_CODE', 'Request a new code first.', 400);
  if (new Date(v.expires_at) <= new Date()) {
    await db.query(`UPDATE account_phone_verifications SET status = 'expired' WHERE id = $1`, [v.id]);
    throw new PhoneError('EXPIRED', 'That code has expired. Request a new one.', 400);
  }
  const attempts = v.attempts + 1;
  let ok = false;
  if (code4.CODE_RE.test(String(code || ''))) {
    if (v.provider === 'local_test') ok = code4.matches(v.code_hash, v.id, code);
    else { try { ok = await require('./sasha/phone/verification')._twilioVerify.check(v.phone_e164, String(code), deps); } catch (_e) { ok = false; } }
  }
  if (!ok) {
    const exhausted = attempts >= v.max_attempts;
    await db.query(`UPDATE account_phone_verifications SET attempts = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END WHERE id = $1`, [v.id, attempts, exhausted]);
    await writeAuditLog({ event_type: 'account.phone_verification_failed', entity_type: 'user', entity_id: userId, actor_id: userId, metadata: { exhausted } }).catch(() => {});
    throw new PhoneError(exhausted ? 'TOO_MANY_ATTEMPTS' : 'WRONG_CODE', exhausted ? 'Too many incorrect codes. Request a new code.' : 'That code is not correct.', 400,
      { attempts_left: Math.max(0, v.max_attempts - attempts) });
  }
  // Single use: only a 'sent' row can be approved, and approving it consumes it.
  const claimed = await db.query(`UPDATE account_phone_verifications SET status = 'approved', attempts = $2, verified_at = now() WHERE id = $1 AND status = 'sent' RETURNING id`, [v.id, attempts]);
  if (!claimed.rowCount) throw new PhoneError('NO_CODE', 'Request a new code first.', 400);
  const before = (await db.query(`SELECT email, phone, phone_verified_at, phone_verified_e164 FROM users WHERE id = $1`, [userId])).rows[0];
  const changed = isVerified(before) && before.phone_verified_e164 !== v.phone_e164;
  await db.query(`UPDATE users SET phone = $2, phone_verified_e164 = $2, phone_verified_at = now(), phone_changed_at = CASE WHEN $3 THEN now() ELSE phone_changed_at END
    WHERE id = $1`, [userId, v.phone_e164, changed]);
  const shared = Number((await db.query(`SELECT count(*)::int n FROM users u WHERE u.id <> $1 AND ${VERIFIED_SQL('u')} AND u.phone_verified_e164 = $2`, [userId, v.phone_e164])).rows[0].n);
  await writeAuditLog({ event_type: changed ? 'account.phone_changed' : 'account.phone_verified', entity_type: 'user', entity_id: userId, actor_id: userId,
    metadata: { phone_last4: last4(v.phone_e164), previous_last4: before && before.phone_verified_e164 ? last4(before.phone_verified_e164) : null, shared_with_other_accounts: shared } }).catch(() => {});
  if (changed && before.email) {
    const mail = deps.emailService || require('./emailService');
    mail.sendEmail({ to: before.email, subject: 'Your Advantage.Bid phone number was changed',
      text: `The verified phone number on your Advantage.Bid account was changed to a number ending in ${last4(v.phone_e164)}. If you did not make this change, reply to this email or contact us right away.` })
      .catch(() => {});
  }
  return { verified: true, phone_last4: last4(v.phone_e164), changed, shared_with_other_accounts: shared > 0 };
}

/** Registration / bidding gate helpers. */
async function phoneGate(userId, { registeredAt = null } = {}) {
  const c = await config();
  if (!c.required) return { required: false, ok: true };
  const u = (await db.query(`SELECT phone, phone_verified_at, phone_verified_e164 FROM users WHERE id = $1`, [userId])).rows[0];
  const verified = isVerified(u);
  if (verified) return { required: true, ok: true };
  // Bidding: registrations made before the requirement started keep working for that auction.
  if (registeredAt && c.required_since && new Date(registeredAt) < new Date(c.required_since)) return { required: true, ok: true, grandfathered: true };
  return { required: true, ok: false };
}

/** Super Admin switches. Requiring phones is refused while no code sender works (never break registration). */
async function setConfig(patch = {}, { actorId } = {}, deps = {}) {
  const writes = [];
  for (const k of ['required', 'verification_enabled']) if (k in patch) {
    if (typeof patch[k] !== 'boolean') throw new PhoneError('BAD_VALUE', k + ' must be true or false');
    writes.push([k, patch[k]]);
  }
  if (!writes.length) throw new PhoneError('BAD_VALUE', 'Nothing to change.');
  const cur = await config();
  const next = { ...cur, ...Object.fromEntries(writes) };
  if (next.required && !next.verification_enabled) throw new PhoneError('NOT_READY', 'Turn on phone verification before requiring it.');
  if (next.required && !(deps.sender || (process.env.TWILIO_VERIFY_SERVICE_SID && process.env.TWILIO_ACCOUNT_SID))) {
    throw new PhoneError('NOT_READY', 'No phone-code sender is configured yet (Twilio Verify), so requiring verified phones would block registration.');
  }
  for (const [k, v] of writes) {
    await db.query(`INSERT INTO platform_config (key, value, category) VALUES ($1, $2::jsonb, 'bidder_phone') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      ['bidder_phone.' + k, JSON.stringify(v)]);
  }
  if (next.required && !cur.required) {
    await db.query(`INSERT INTO platform_config (key, value, category) VALUES ('bidder_phone.required_since', to_jsonb(now()::text), 'bidder_phone')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
  }
  await writeAuditLog({ event_type: 'bidder_phone.config_changed', entity_type: 'platform_config', entity_id: '00000000-0000-0000-0000-000000000000', actor_id: actorId || null,
    metadata: { before: cur, after: next } }).catch(() => {});
  return config();
}

module.exports = { start, confirm, status, isVerified, phoneGate, config, setConfig, verificationAvailable, PhoneError, VERIFIED_SQL,
  LIMITS: { TTL_MIN, MAX_ATTEMPTS, SENDS_PER_30, PER_NUMBER_PER_HOUR, PER_IP_PER_HOUR, LOCK_MIN } };
