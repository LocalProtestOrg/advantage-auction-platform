'use strict';

/**
 * Optional auction text alerts: affirmative, per-type consent (migrations 189 + 190). Kept separate from:
 *   - the account phone number and its verification (security), and
 *   - one-time texts a customer asks for (Phone Sasha customer-service texts and payment links).
 * A verified phone NEVER implies consent. Nobody is enrolled silently. Boxes are never pre-checked.
 *
 * CONSENT WORDING IS SERVER-CONTROLLED AND VERSIONED. presentation() returns the exact heading, checkbox labels,
 * disclosure and links a page must render (as text, never rewritten in the browser), plus CONSENT_VERSION. An opt-in
 * must send back the version and the last 4 digits it displayed; a mismatch is refused as stale (STALE_CONSENT), so the
 * stored record is always exactly what the customer saw. recordText() builds that stored text from the same source.
 *
 *   sms_consents        current state per (user, type): status, timestamps, source, surface, context, exact consent text,
 *                       consent version, Terms/Privacy "Last Updated" shown, and the number consented with
 *   sms_consent_events  every opt-in and opt-out, forever (audit)
 *
 * A consent counts only for the number it was given for: if the verified number changes, alerts stop until the
 * customer opts in again. Opting in requires a verified phone, the offer switch (auction_sms.offer_opt_in) and a number
 * that has not replied STOP. Opting out is always allowed, from any source, including STOP replies.
 */

const db = require('../db');
const { identifierHash, last4 } = require('../lib/phoneNumber');

const TYPES = ['outbid', 'watched_closing'];
const CONSENT_VERSION = 'sms-alerts-v2';
const LEGAL = { terms_last_updated: '2026-10-07', privacy_last_updated: '2026-10-07' };
const LINKS = [{ text: 'Terms', href: '/terms.html' }, { text: 'Privacy Policy', href: '/privacy.html' }];
const LABELS = {
  outbid: 'Yes, text me Advantage.Bid outbid alerts (at most one text per lot every 5 minutes).',
  watched_closing: 'Yes, text me Advantage.Bid reminders about 1 hour before lots begin closing in auctions I watch (about one per watched auction).',
};
const SHORT_NAMES = { outbid: 'Outbid alerts', watched_closing: 'Watched auction closing reminders' };
const SURFACES = {
  auction_registration: {
    heading: 'Optional text alerts from Advantage.Bid',
    disclosure: (l4) => `Optional. Not required to register or bid. Texts go to your verified number ending in ${l4}. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. You can turn these off any time in Notifications.`,
  },
  notification_settings: {
    heading: 'Text message alerts',
    showsShortNames: true,   // the page shows "Outbid alerts: Yes, text me ..."
    disclosure: (l4) => `Optional. Texts go to your verified number ending in ${l4}. Message frequency varies. Msg & data rates may apply. Reply STOP to any text to stop all Advantage.Bid texts to this number; reply HELP for help.`,
  },
};
// Back-compat for readers of the per-type wording (Super Admin tester, older callers).
const CONSENT_TEXT = LABELS;

const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE', 'STOPPLEASE'];
const START_WORDS = ['START', 'UNSTOP', 'YES'];
const HELP_WORDS = ['HELP', 'INFO'];
const HELP_REPLY = 'Advantage.Bid: Help at info@advantage.bid or (551) 655-7050. Manage alerts at bid.advantage.bid/notifications.html. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.';
const STOP_REPLY = 'Advantage.Bid: You\'re unsubscribed and will not receive more texts from this number. Reply START to resubscribe. Help: info@advantage.bid';

/** Exactly what a page must render for one surface. Every string is shown verbatim. */
function presentation(surface, phoneLast4) {
  const s = SURFACES[surface];
  if (!s) throw new ConsentError('BAD_SOURCE', 'Unknown source.');
  return { consent_version: CONSENT_VERSION, surface, heading: s.heading, labels: { ...LABELS }, short_names: { ...SHORT_NAMES },
    disclosure: s.disclosure(phoneLast4 || '----'), links: LINKS.map((l) => ({ ...l })), phone_last4: phoneLast4 || null, ...LEGAL };
}

/** The stored consent text: the heading, the checkbox label, the disclosure and the links, exactly as presented. */
function recordText(type, surface, phoneLast4) {
  const p = presentation(surface, phoneLast4);
  const label = SURFACES[surface].showsShortNames ? `${p.short_names[type]}: ${p.labels[type]}` : p.labels[type];
  return `${p.heading}: ${label} ${p.disclosure} ${p.links.map((l) => `${l.text} (https://bid.advantage.bid${l.href})`).join(' · ')}`;
}

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

async function verifiedE164(userId, runner = db) {
  const u = (await runner.query(`SELECT phone, phone_verified_at, phone_verified_e164 FROM users WHERE id = $1`, [userId])).rows[0];
  return u && require('./accountPhoneService').isVerified(u) ? u.phone_verified_e164 : null;
}

/** Effective state: opted in AND consented for the CURRENT verified number. */
async function get(userId) {
  const rows = (await db.query(`SELECT sms_type, status, opted_in_at, opted_out_at, source, phone_e164_at_opt_in FROM sms_consents WHERE user_id = $1`, [userId])).rows;
  const current = await verifiedE164(userId);
  const out = {};
  for (const t of TYPES) {
    const r = rows.find((x) => x.sms_type === t);
    const on = !!(r && r.status === 'opted_in');
    const sameNumber = !!(on && current && r.phone_e164_at_opt_in === current);
    out[t] = { opted_in: sameNumber, needs_reconfirm: on && !sameNumber, opted_in_at: r ? r.opted_in_at : null, opted_out_at: r ? r.opted_out_at : null,
      label: LABELS[t], consent_text: LABELS[t] };
  }
  return out;
}

async function isOptedIn(userId, type, runner = db) {
  const r = (await runner.query(`SELECT c.status, c.phone_e164_at_opt_in, u.phone, u.phone_verified_at, u.phone_verified_e164
    FROM sms_consents c JOIN users u ON u.id = c.user_id WHERE c.user_id = $1 AND c.sms_type = $2`, [userId, type])).rows[0];
  return !!(r && r.status === 'opted_in' && require('./accountPhoneService').isVerified(r) && r.phone_e164_at_opt_in === r.phone_verified_e164);
}

/**
 * Record one choice. Opt-in: only from the registration panel or Notifications settings, needs the program offered, a
 * verified phone that has not replied STOP, and the consent version + last 4 digits the page displayed. Opt-out always.
 */
async function set(userId, type, optIn, { source, context = {}, ip = null, consentVersion = null, shownLast4 = null } = {}) {
  if (!TYPES.includes(type)) throw new ConsentError('BAD_TYPE', 'Unknown alert type.');
  if (!['auction_registration', 'notification_settings', 'sms_keyword', 'admin'].includes(source)) throw new ConsentError('BAD_SOURCE', 'Unknown source.');
  const u = (await db.query(`SELECT phone, phone_verified_at, phone_verified_e164 FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u) throw new ConsentError('NO_USER', 'Account not found.', 404);
  const raw = (await db.query(`SELECT status, phone_e164_at_opt_in FROM sms_consents WHERE user_id = $1 AND sms_type = $2`, [userId, type])).rows[0];
  let text = null; let surface = null; let l4 = null;
  if (optIn) {
    if (!SURFACES[source]) throw new ConsentError('BAD_SOURCE', 'Text alerts can only be turned on by the account holder on the website.', 403);
    if (!(await settings()).offer_opt_in) throw new ConsentError('NOT_OFFERED', 'Text alerts are not available yet.', 409);
    if (!require('./accountPhoneService').isVerified(u)) throw new ConsentError('PHONE_NOT_VERIFIED', 'Verify your mobile number first.', 403);
    l4 = last4(u.phone_verified_e164);
    if (consentVersion !== CONSENT_VERSION || String(shownLast4 || '') !== String(l4)) {
      throw new ConsentError('STALE_CONSENT', 'This page is out of date. Reload it and try again.', 409);
    }
    if (await require('./smsSuppressionService').isSuppressed(u.phone_verified_e164)) {
      throw new ConsentError('NUMBER_OPTED_OUT', 'This number replied STOP to Advantage.Bid texts. Reply START to any Advantage.Bid text from this phone, then turn alerts on here.', 409);
    }
    if (raw && raw.status === 'opted_in' && raw.phone_e164_at_opt_in === u.phone_verified_e164) return { changed: false, opted_in: true };
    surface = source; text = recordText(type, source, l4);
  } else if (!raw || raw.status !== 'opted_in') {
    return { changed: false, opted_in: false };
  }
  const legal = optIn ? LEGAL : { terms_last_updated: null, privacy_last_updated: null };
  await db.query(
    `INSERT INTO sms_consents (user_id, sms_type, status, opted_in_at, opted_out_at, source, source_context, consent_text, phone_e164_at_opt_in,
        consent_version, terms_last_updated, privacy_last_updated, surface, updated_at)
     VALUES ($1,$2,$3, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN NULL ELSE now() END, $5, $6::jsonb, $7, CASE WHEN $4 THEN $8 END, $9, $10, $11, $12, now())
     ON CONFLICT (user_id, sms_type) DO UPDATE SET status = EXCLUDED.status,
       opted_in_at = CASE WHEN $4 THEN now() ELSE sms_consents.opted_in_at END,
       opted_out_at = CASE WHEN $4 THEN NULL ELSE now() END,
       source = EXCLUDED.source, source_context = EXCLUDED.source_context,
       consent_text = CASE WHEN $4 THEN EXCLUDED.consent_text ELSE sms_consents.consent_text END,
       phone_e164_at_opt_in = CASE WHEN $4 THEN EXCLUDED.phone_e164_at_opt_in ELSE sms_consents.phone_e164_at_opt_in END,
       consent_version = CASE WHEN $4 THEN EXCLUDED.consent_version ELSE sms_consents.consent_version END,
       terms_last_updated = CASE WHEN $4 THEN EXCLUDED.terms_last_updated ELSE sms_consents.terms_last_updated END,
       privacy_last_updated = CASE WHEN $4 THEN EXCLUDED.privacy_last_updated ELSE sms_consents.privacy_last_updated END,
       surface = CASE WHEN $4 THEN EXCLUDED.surface ELSE sms_consents.surface END, updated_at = now()`,
    [userId, type, optIn ? 'opted_in' : 'opted_out', !!optIn, source, JSON.stringify(context || {}), text, u.phone_verified_e164 || null,
      optIn ? CONSENT_VERSION : null, legal.terms_last_updated, legal.privacy_last_updated, surface]);
  const evLast4 = optIn ? l4 : (raw && raw.phone_e164_at_opt_in ? last4(raw.phone_e164_at_opt_in) : (u.phone_verified_e164 ? last4(u.phone_verified_e164) : null));
  await db.query(`INSERT INTO sms_consent_events (user_id, sms_type, action, source, source_context, consent_text, phone_last4, ip_hash,
      consent_version, terms_last_updated, privacy_last_updated, surface)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)`, [userId, type, optIn ? 'opt_in' : 'opt_out', source, JSON.stringify(context || {}),
    text, evLast4, ip ? identifierHash('ip:' + ip) : null, optIn ? CONSENT_VERSION : null, legal.terms_last_updated, legal.privacy_last_updated, surface]);
  return { changed: true, opted_in: !!optIn };
}

/**
 * Boxes the bidder checked in the auction registration panel: { outbid?: true, watched_closing?: true, consent_version,
 * shown_last4 }. Only true values count; unchecked means no change. Never required to register.
 */
async function applyFromRegistration(userId, auctionId, choices, { ip } = {}) {
  const out = {};
  for (const t of TYPES) if (choices && choices[t] === true) {
    out[t] = await set(userId, t, true, { source: 'auction_registration', context: { auction_id: auctionId }, ip,
      consentVersion: choices.consent_version || null, shownLast4: choices.shown_last4 || null });
  }
  return out;
}

/** What the registration panel should offer this bidder (with the exact wording to render). */
async function offerFor(userId, phoneVerified) {
  const s = await settings();
  if (!s.offer_opt_in || !phoneVerified) return { offer: false };
  const e164 = await verifiedE164(userId);
  if (!e164 || await require('./smsSuppressionService').isSuppressed(e164)) return { offer: false };
  const cur = await get(userId);
  return { offer: TYPES.some((t) => !cur[t].opted_in), current: { outbid: cur.outbid.opted_in, watched_closing: cur.watched_closing.opted_in },
    presentation: presentation('auction_registration', last4(e164)) };
}

/** Turn off every optional alert tied to a number (verified now, or consented with). Used by STOP and provider unsubscribes. */
async function optOutNumber(e164, { source = 'sms_keyword', context = {} } = {}) {
  const accounts = (await db.query(`SELECT DISTINCT u.id FROM users u LEFT JOIN sms_consents c ON c.user_id = u.id
    WHERE (${require('./accountPhoneService').VERIFIED_SQL('u')} AND u.phone_verified_e164 = $1) OR c.phone_e164_at_opt_in = $1`, [e164])).rows;
  let changed = 0;
  for (const a of accounts) for (const t of TYPES) { const r = await set(a.id, t, false, { source, context }); if (r.changed) changed++; }
  return { accounts: accounts.length, changed };
}

function keywordOf(body) { return String(body || '').trim().toUpperCase().replace(/[^A-Z]/g, ''); }
function classify(body, optOutType = null) {
  const t = String(optOutType || '').toUpperCase();
  if (t === 'STOP' || t === 'START' || t === 'HELP') return { action: t.toLowerCase(), keyword: keywordOf(body) || t };
  const w = keywordOf(body);
  if (STOP_WORDS.includes(w)) return { action: 'stop', keyword: w };
  if (START_WORDS.includes(w)) return { action: 'start', keyword: w };
  if (HELP_WORDS.includes(w)) return { action: 'help', keyword: w };
  return { action: 'other', keyword: null };
}

/**
 * One inbound keyword. STOP-family: suppress the number and turn off both alert types for every account tied to it.
 * START-family: release the number only (alerts stay off). HELP: nothing changes (the provider sends the help reply).
 */
async function handleInboundKeyword(fromE164, body, { optOutType = null } = {}) {
  const c = classify(body, optOutType);
  const supp = require('./smsSuppressionService');
  if (c.action === 'help') return { action: 'help', keyword: c.keyword, reply: HELP_REPLY, accounts: 0, changed: 0 };
  if (c.action === 'start') { const r = await supp.release(fromE164, { reason: 'start_keyword' }); return { action: 'start', keyword: c.keyword, released: r.released, accounts: 0, changed: 0 }; }
  if (c.action !== 'stop') return { action: 'none', keyword: null, accounts: 0, changed: 0 };
  await supp.suppress(fromE164, { reason: 'stop_keyword', keyword: c.keyword });
  const r = await optOutNumber(fromE164, { source: 'sms_keyword', context: { keyword: c.keyword } });
  return { action: 'stop', keyword: c.keyword, reply: STOP_REPLY, accounts: r.accounts, changed: r.changed };
}

module.exports = { TYPES, CONSENT_VERSION, LEGAL, LABELS, SHORT_NAMES, CONSENT_TEXT, presentation, recordText, settings, get, set, isOptedIn,
  applyFromRegistration, offerFor, optOutNumber, handleInboundKeyword, classify, ConsentError, STOP_WORDS, START_WORDS, HELP_WORDS, HELP_REPLY, STOP_REPLY };
