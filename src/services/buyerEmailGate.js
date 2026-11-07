'use strict';

/**
 * buyerEmailGate: "verified email address required to bid" (owner direction 2026-11-06). Ships OFF.
 *
 * Switches (platform_config, category 'buyers'; absent rows read as the defaults below, so no migration is needed):
 *   buyers.require_verified_email_to_bid   boolean, default false. When true, registering for an auction and placing a
 *                                          bid need a verified email address (users.email_verified).
 *   buyers.verified_email_grace_days       integer 0..365, default 30. Grace period for ESTABLISHED buyers (below).
 *   buyers.require_verified_email_since    set automatically each time the requirement is turned on.
 *
 * Transition (docs/operations/buyer-verification-transition.md): an established buyer, meaning an account that had
 * placed a bid or made a purchase before the requirement was turned on, keeps bidding during the grace period and is
 * asked to confirm; after it, the requirement applies to them too. Every other account (new accounts, and existing
 * accounts that never bid or bought) must confirm before registering or bidding. Administrators are exempt
 * (admin override). Confirming is one click from the email; the resend is throttled per account.
 */

const db = require('../db');

const KEY = {
  required: 'buyers.require_verified_email_to_bid',
  grace: 'buyers.verified_email_grace_days',
  since: 'buyers.require_verified_email_since',
};
const DEFAULT_GRACE_DAYS = 30;
const MAX_GRACE_DAYS = 365;

class EmailGateError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function asBool(v) { return v === true || v === 'true'; }

async function config(runner = db) {
  let rows = [];
  try { rows = (await runner.query('SELECT key, value FROM platform_config WHERE key = ANY($1)', [Object.values(KEY)])).rows; }
  catch (_e) { rows = []; }   // no config table (fresh database): the defaults apply, i.e. OFF
  const get = (k) => { const r = rows.find((x) => x.key === k); return r ? r.value : null; };
  const g = parseInt(get(KEY.grace), 10);
  const since = get(KEY.since);
  return {
    required: asBool(get(KEY.required)),
    grace_days: Number.isFinite(g) && g >= 0 ? Math.min(g, MAX_GRACE_DAYS) : DEFAULT_GRACE_DAYS,
    required_since: since && !Number.isNaN(new Date(since).getTime()) ? new Date(since).toISOString() : null,
  };
}

// An account that had bid or bought before the requirement started. Each source is read separately and a missing table
// counts as "no activity", so this never throws.
async function hadActivityBefore(userId, sinceIso) {
  const since = sinceIso || new Date().toISOString();
  const probes = [
    ['SELECT 1 FROM bids WHERE bidder_user_id = $1 AND created_at < $2 LIMIT 1'],
    ['SELECT 1 FROM buyer_auction_invoices WHERE buyer_user_id = $1 AND created_at < $2 LIMIT 1'],
    [`SELECT 1 FROM marketplace_orders WHERE buyer_user_id = $1 AND payment_status = 'paid' AND created_at < $2 LIMIT 1`],
  ];
  for (const [sql] of probes) {
    try { if ((await db.query(sql, [userId, since])).rows.length) return true; } catch (_e) { /* table absent */ }
  }
  return false;
}

/**
 * The gate for one account. Returns:
 *   { required, verified, ok, grandfathered, grace_until, must_verify }
 * `ok` = may register/bid now. `must_verify` = the account should be asked to confirm (true for a grandfathered
 * account inside its grace period, so the member area can prompt without blocking).
 */
async function status(userId) {
  const c = await config();
  const u = userId ? (await db.query('SELECT role, email_verified, created_at FROM users WHERE id = $1', [userId])).rows[0] : null;
  const verified = !!(u && u.email_verified === true);
  const base = { required: c.required, verified, grandfathered: false, grace_until: null };
  if (!c.required) return { ...base, ok: true, must_verify: false };
  if (verified) return { ...base, ok: true, must_verify: false };
  if (u && u.role === 'admin') return { ...base, ok: true, must_verify: false, exempt: true };
  const since = c.required_since;
  const existedBefore = !!(u && since && new Date(u.created_at) < new Date(since));
  if (existedBefore && await hadActivityBefore(userId, since)) {
    const graceUntil = new Date(new Date(since).getTime() + c.grace_days * 86400000);
    const inGrace = Date.now() < graceUntil.getTime();
    return { ...base, grandfathered: true, grace_until: graceUntil.toISOString(), ok: inGrace, must_verify: true };
  }
  return { ...base, ok: false, must_verify: true };
}

// Bid / registration path: with the requirement OFF this is one small config read and nothing else.
async function gate(userId) {
  const c = await config();
  if (!c.required) return { ok: true, required: false };
  return status(userId);
}

const BLOCK_MESSAGE = 'Please confirm your email address to bid. Check your inbox for our confirmation link, or send a new one from the Confirm Your Email page.';

/** Administrator switch (audited by the caller's route). Turning the requirement on (re)starts the grace period. */
async function setConfig(patch = {}, { actorId = null } = {}) {
  const writes = [];
  if ('required' in patch) {
    if (typeof patch.required !== 'boolean') throw new EmailGateError('BAD_VALUE', 'required must be true or false');
    writes.push([KEY.required, patch.required]);
  }
  if ('grace_days' in patch) {
    const g = Number(patch.grace_days);
    if (!Number.isInteger(g) || g < 0 || g > MAX_GRACE_DAYS) throw new EmailGateError('BAD_VALUE', 'grace_days must be a whole number from 0 to ' + MAX_GRACE_DAYS);
    writes.push([KEY.grace, g]);
  }
  if (!writes.length) throw new EmailGateError('BAD_VALUE', 'Nothing to change.');
  const cur = await config();
  const upsert = (k, v) => db.query(
    `INSERT INTO platform_config (key, value, category, description) VALUES ($1, $2::jsonb, 'buyers', $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [k, JSON.stringify(v), DESCRIPTIONS[k] || null]);
  for (const [k, v] of writes) await upsert(k, v);
  if (patch.required === true && !cur.required) await upsert(KEY.since, new Date().toISOString());
  const next = await config();
  try {
    await require('../lib/auditLog').writeAuditLog({ event_type: 'buyers.email_verification_config_changed', entity_type: 'platform_config',
      entity_id: '00000000-0000-0000-0000-000000000000', actor_id: actorId, metadata: { before: cur, after: next } });
  } catch (_e) { /* audit is best-effort */ }
  return next;
}

const DESCRIPTIONS = {
  [KEY.required]: 'Require a verified email address to register for an auction and to bid (admins exempt).',
  [KEY.grace]: 'Days established buyers (bid or bought before the requirement started) may keep bidding while asked to confirm.',
  [KEY.since]: 'When the verified-email requirement was last turned on (set automatically; starts the grace period).',
};

// One-click resend, throttled per account: at most one email a minute and five an hour (in memory, per instance).
const RESEND_MIN_GAP_MS = 60 * 1000;
const RESEND_PER_HOUR = 5;
const resendLog = new Map();
function resendAllowed(userId, now = Date.now()) {
  const list = (resendLog.get(userId) || []).filter((t) => now - t < 3600 * 1000);
  resendLog.set(userId, list);
  if (list.length && now - list[list.length - 1] < RESEND_MIN_GAP_MS) return { ok: false, retry_after_s: Math.ceil((RESEND_MIN_GAP_MS - (now - list[list.length - 1])) / 1000) };
  if (list.length >= RESEND_PER_HOUR) return { ok: false, retry_after_s: Math.ceil((3600 * 1000 - (now - list[0])) / 1000) };
  return { ok: true };
}
function noteResend(userId, now = Date.now()) { const l = resendLog.get(userId) || []; l.push(now); resendLog.set(userId, l); }
function _resetResends() { resendLog.clear(); }

module.exports = { config, status, gate, setConfig, hadActivityBefore, resendAllowed, noteResend, _resetResends,
  BLOCK_MESSAGE, KEY, DEFAULT_GRACE_DAYS, EmailGateError };
