'use strict';

/**
 * Optional auction text alerts: affirmative, per-type consent (migration 189). Kept separate from:
 *   - the account phone number (required for bidders) and its verification (security), and
 *   - Phone Sasha verification codes and customer-service messages (transactional, requested in the moment).
 * A verified phone NEVER implies consent. Nobody is enrolled silently.
 *
 *   sms_consents        current state per (user, type): opted_in / opted_out, timestamps, source, context, consent text
 *   sms_consent_events  every opt-in and opt-out, forever (audit)
 *
 * Opting in requires a verified phone and the offer switch (auction_sms.offer_opt_in) so consent is only collected
 * once the program is ready. Opting out is always allowed, from any source, including STOP replies.
 */

const db = require('../db');
const { identifierHash, last4 } = require('../lib/phoneNumber');

const TYPES = ['outbid', 'watched_closing'];
const CONSENT_TEXT = {
  outbid: 'Text me when I am outbid on a lot (at most one text per lot every 5 minutes). Message and data rates may apply. Reply STOP to opt out, HELP for help.',
  watched_closing: 'Text me about 1 hour before lots begin closing in an auction I am watching. Message and data rates may apply. Reply STOP to opt out, HELP for help.',
};
const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'];
const HELP_WORDS = ['HELP', 'INFO'];
const HELP_REPLY = 'Advantage.Bid auction alerts. Manage alerts at https://bid.advantage.bid/notifications.html or email info@advantage.bid. Reply STOP to opt out.';
const STOP_REPLY = 'You are unsubscribed from Advantage.Bid auction text alerts. No more alerts will be sent.';

async function settings(runner = db) {
  const rows = (await runner.query(`SELECT key, value FROM platform_config WHERE key LIKE 'auction_sms.%'`)).rows;
  const s = { enabled: false, a2p_confirmed: false, offer_opt_in: false, outbid_cooldown_minutes: 5, watched_reminder_minutes: 60 };
  for (const { key, value } of rows) {
    const k = key.slice('auction_sms.'.length);
    if (['enabled', 'a2p_confirmed', 'offer_opt_in'].includes(k)) s[k] = value === true;
    else if (k in s && Number.isFinite(Number(value)) && Number(value) > 0) s[k] = Number(value);
  }
  return s;
}

class ConsentError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }

async function get(userId) {
  const rows = (await db.query(`SELECT sms_type, status, opted_in_at, opted_out_at, source FROM sms_consents WHERE user_id = $1`, [userId])).rows;
  const out = {};
  for (const t of TYPES) {
    const r = rows.find((x) => x.sms_type === t);
    out[t] = { opted_in: !!(r && r.status === 'opted_in'), opted_in_at: r ? r.opted_in_at : null, opted_out_at: r ? r.opted_out_at : null, consent_text: CONSENT_TEXT[t] };
  }
  return out;
}

async function isOptedIn(userId, type, runner = db) {
  const r = (await runner.query(`SELECT status FROM sms_consents WHERE user_id = $1 AND sms_type = $2`, [userId, type])).rows[0];
  return !!(r && r.status === 'opted_in');
}

/** Record one choice. Opt-in needs a verified phone and the program to be offered; opt-out always works. */
async function set(userId, type, optIn, { source, context = {}, ip = null } = {}) {
  if (!TYPES.includes(type)) throw new ConsentError('BAD_TYPE', 'Unknown alert type.');
  if (!['auction_registration', 'notification_settings', 'sms_keyword', 'admin'].includes(source)) throw new ConsentError('BAD_SOURCE', 'Unknown source.');
  const u = (await db.query(`SELECT phone, phone_verified_at, phone_verified_e164 FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u) throw new ConsentError('NO_USER', 'Account not found.', 404);
  if (optIn) {
    if (!(await settings()).offer_opt_in) throw new ConsentError('NOT_OFFERED', 'Text alerts are not available yet.', 409);
    if (!require('./accountPhoneService').isVerified(u)) throw new ConsentError('PHONE_NOT_VERIFIED', 'Verify your mobile number first.', 403);
  }
  const current = await isOptedIn(userId, type);
  if (current === !!optIn) return { changed: false, opted_in: current };
  await db.query(
    `INSERT INTO sms_consents (user_id, sms_type, status, opted_in_at, opted_out_at, source, source_context, consent_text, phone_e164_at_opt_in, updated_at)
     VALUES ($1,$2,$3, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN NULL ELSE now() END, $5, $6::jsonb, $7, CASE WHEN $4 THEN $8 END, now())
     ON CONFLICT (user_id, sms_type) DO UPDATE SET status = EXCLUDED.status,
       opted_in_at = CASE WHEN $4 THEN now() ELSE sms_consents.opted_in_at END,
       opted_out_at = CASE WHEN $4 THEN NULL ELSE now() END,
       source = EXCLUDED.source, source_context = EXCLUDED.source_context,
       consent_text = CASE WHEN $4 THEN EXCLUDED.consent_text ELSE sms_consents.consent_text END,
       phone_e164_at_opt_in = CASE WHEN $4 THEN EXCLUDED.phone_e164_at_opt_in ELSE sms_consents.phone_e164_at_opt_in END, updated_at = now()`,
    [userId, type, optIn ? 'opted_in' : 'opted_out', !!optIn, source, JSON.stringify(context || {}), CONSENT_TEXT[type], u.phone_verified_e164 || null]);
  await db.query(`INSERT INTO sms_consent_events (user_id, sms_type, action, source, source_context, consent_text, phone_last4, ip_hash)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, [userId, type, optIn ? 'opt_in' : 'opt_out', source, JSON.stringify(context || {}),
    optIn ? CONSENT_TEXT[type] : null, u.phone_verified_e164 ? last4(u.phone_verified_e164) : null, ip ? identifierHash('ip:' + ip) : null]);
  return { changed: true, opted_in: !!optIn };
}

/** Boxes the bidder ticked in the auction registration panel (only true values; unticked means no change). */
async function applyFromRegistration(userId, auctionId, choices, { ip } = {}) {
  const out = {};
  for (const t of TYPES) if (choices && choices[t] === true) out[t] = await set(userId, t, true, { source: 'auction_registration', context: { auction_id: auctionId }, ip });
  return out;
}

/** What the registration panel should offer this bidder. */
async function offerFor(userId, phoneVerified) {
  const s = await settings();
  if (!s.offer_opt_in || !phoneVerified) return { offer: false };
  const cur = await get(userId);
  return { offer: TYPES.some((t) => !cur[t].opted_in), current: { outbid: cur.outbid.opted_in, watched_closing: cur.watched_closing.opted_in }, consent_text: CONSENT_TEXT };
}

/**
 * Inbound SMS keywords (for the future inbound webhook; NOT mounted in this release). STOP-family words opt the sender's
 * number out of every alert type for every account whose VERIFIED phone is that number. HELP returns help text.
 */
async function handleInboundKeyword(fromE164, body) {
  const word = String(body || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (HELP_WORDS.includes(word)) return { action: 'help', reply: HELP_REPLY };
  if (!STOP_WORDS.includes(word)) return { action: 'none' };
  const accounts = (await db.query(`SELECT u.id FROM users u WHERE ${require('./accountPhoneService').VERIFIED_SQL('u')} AND u.phone_verified_e164 = $1`, [fromE164])).rows;
  let changed = 0;
  for (const a of accounts) for (const t of TYPES) { const r = await set(a.id, t, false, { source: 'sms_keyword', context: { keyword: word } }); if (r.changed) changed++; }
  return { action: 'stop', reply: STOP_REPLY, accounts: accounts.length, changed };
}

module.exports = { TYPES, CONSENT_TEXT, settings, get, set, isOptedIn, applyFromRegistration, offerFor, handleInboundKeyword, ConsentError, STOP_WORDS, HELP_REPLY, STOP_REPLY };
