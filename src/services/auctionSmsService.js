'use strict';

/**
 * Optional auction text alerts for opted-in bidders (migration 189). OFF until auction_sms.enabled (and, for real
 * delivery, auction_sms.a2p_confirmed + a configured messaging sender).
 *
 * OUTBID: after a bid commits (bidService post-commit hook) the previous high bidder gets ONE text per lot per rolling
 *   5 minutes (cooldown scoped by user + auction + lot + type). Outbids inside the cooldown are recorded as
 *   'suppressed: cooldown' and never queued for later. At send time the text is re-checked and suppressed if stale:
 *   consent withdrawn, phone no longer verified, bidder is the high bidder again, lot/auction closed, older than 10 min.
 * WATCHED CLOSING: one reminder per bidder + auction, about 60 minutes before the auction's scheduled closing START
 *   (auctions.start_time: when the staggered lot closings begin; soft-close extensions move lots, never start_time).
 *   Recomputed from the current start_time on every scan, so a rescheduled auction is followed; a queued reminder whose
 *   start time changed, or whose auction is no longer live, or whose bidder stopped watching or opted out, is suppressed.
 *
 * Every decision is a row in auction_sms_messages (sent or suppressed, with the reason). The decision logic is pure
 * (decideOutbid / decideWatchedReminder) and shared with the Super Admin tester's scenario runner.
 */

const crypto = require('crypto');
const db = require('../db');
const consent = require('./smsConsentService');
const { isTextable, last4 } = require('../lib/phoneNumber');

const SITE = () => require('../lib/publicUrls').publicBaseUrl();
const OUTBID_STALE_MINUTES = 10;
const RESCHEDULE_TOLERANCE_MS = 2 * 60 * 1000;
const LIVE_AUCTION_STATES = ['published', 'active'];

// ── message text ─────────────────────────────────────────────────────────────────────────────────────
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
function lotUrl(lotId) { return `${SITE()}/lot.html?lotId=${lotId}`; }
function auctionUrl(auctionId) { return `${SITE()}/auction-view.html?auctionId=${auctionId}`; }
function buildOutbidSms(lot) {
  const num = lot.lot_number_display || lot.lot_number;
  return `Advantage.Bid: You've been outbid on Lot ${num}, ${clip(lot.title, 40)}. View the lot and bid again: ${lotUrl(lot.id)} Reply STOP to opt out.`;
}
function buildWatchedSms(auction) {
  return `Advantage.Bid: An auction you're watching begins closing in about 1 hour: ${clip(auction.title, 50)}. View auction: ${auctionUrl(auction.id)} Reply STOP to opt out.`;
}

// ── pure decisions ───────────────────────────────────────────────────────────────────────────────────
/** f: { optedIn, phoneVerified, textable, lot, auction, userIsHighBidder, userHasBid, createdAt, lastSentAt } */
function decideOutbid(f, now, cooldownMinutes = 5) {
  const t = now.getTime();
  if (!f.optedIn) return { send: false, reason: 'no_consent' };
  if (!f.phoneVerified) return { send: false, reason: 'phone_not_verified' };
  if (!f.textable) return { send: false, reason: 'not_textable' };
  if (!f.lot) return { send: false, reason: 'lot_missing' };
  if (!['open', 'active'].includes(f.lot.state) || !f.lot.closes_at || new Date(f.lot.closes_at).getTime() <= t) return { send: false, reason: 'lot_closed' };
  if (!f.auction || !LIVE_AUCTION_STATES.includes(f.auction.state) || f.auction.is_archived || f.auction.is_demo) return { send: false, reason: 'auction_not_live' };
  if (f.userIsHighBidder) return { send: false, reason: 'regained_high_bid' };
  if (!f.userHasBid) return { send: false, reason: 'not_a_bidder' };
  if (f.createdAt && t - new Date(f.createdAt).getTime() > OUTBID_STALE_MINUTES * 60000) return { send: false, reason: 'stale' };
  if (f.lastSentAt && t - new Date(f.lastSentAt).getTime() < cooldownMinutes * 60000) return { send: false, reason: 'cooldown' };
  return { send: true };
}

/** f: { optedIn, phoneVerified, textable, watching, auction, snapshotStart, alreadySent } */
function decideWatchedReminder(f, now, minutesBefore = 60) {
  const t = now.getTime();
  if (!f.optedIn) return { send: false, reason: 'no_consent' };
  if (!f.phoneVerified) return { send: false, reason: 'phone_not_verified' };
  if (!f.textable) return { send: false, reason: 'not_textable' };
  if (f.alreadySent) return { send: false, reason: 'already_sent' };
  if (!f.watching) return { send: false, reason: 'not_watching' };
  if (!f.auction || !LIVE_AUCTION_STATES.includes(f.auction.state) || f.auction.is_archived || f.auction.is_demo) return { send: false, reason: 'auction_not_live' };
  if (!f.auction.start_time) return { send: false, reason: 'no_closing_time' };
  const start = new Date(f.auction.start_time).getTime();
  if (f.snapshotStart && Math.abs(new Date(f.snapshotStart).getTime() - start) > RESCHEDULE_TOLERANCE_MS) return { send: false, reason: 'rescheduled' };
  if (t < start - (minutesBefore + 5) * 60000) return { send: false, reason: 'not_due' };
  if (t > start - 15 * 60000) return { send: false, reason: 'too_late' };
  return { send: true };
}

// ── settings / delivery ──────────────────────────────────────────────────────────────────────────────
async function liveReady(s) {
  return !!(s.enabled && s.a2p_confirmed && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    && (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER));
}
async function deliver(to, body, s, deps) {
  if (deps.sender) return deps.sender(to, body);   // tests / simulation
  if (!(await liveReady(s))) return { sent: false, reason: 'not_ready' };
  if (!isTextable(to)) return { sent: false, reason: 'not_textable' };
  const r = await require('./smsService').sendSMS({ to, message: body });
  return { sent: true, ref: (r && (r.sid || r.messageSid)) || null };
}

async function userFacts(userId, type, runner = db) {
  const u = (await runner.query(`SELECT id, phone, phone_verified_at, phone_verified_e164, COALESCE(is_active, true) active, COALESCE(is_demo, false) demo FROM users WHERE id = $1`, [userId])).rows[0];
  const verified = !!u && u.active && require('./accountPhoneService').isVerified(u);
  return { u, optedIn: !!u && await consent.isOptedIn(userId, type, runner), phoneVerified: verified, textable: verified && !u.demo && (isTextable(u.phone_verified_e164) || false) };
}

// ── outbid ───────────────────────────────────────────────────────────────────────────────────────────
/**
 * Post-commit hook from bidService (fire-and-forget; can never affect the bid). Records nothing for bidders who did
 * not opt in. Outbids inside the cooldown are logged as suppressed, never queued.
 */
async function onOutbid({ userId, lot }, deps = {}) {
  if (!userId || !lot) return { skipped: 'no_user' };
  const s = await consent.settings();
  if (!s.enabled && !deps.force) return { skipped: 'disabled' };
  const f = await userFacts(userId, 'outbid');
  if (!f.optedIn || !f.phoneVerified) return { skipped: 'not_eligible' };
  const last = (await db.query(`SELECT sent_at FROM auction_sms_messages WHERE user_id = $1 AND lot_id = $2 AND kind = 'outbid' AND status = 'sent'
    ORDER BY sent_at DESC LIMIT 1`, [userId, lot.id])).rows[0];
  const inCooldown = last && Date.now() - new Date(last.sent_at).getTime() < s.outbid_cooldown_minutes * 60000;
  const pendingAlready = (await db.query(`SELECT 1 FROM auction_sms_messages WHERE user_id = $1 AND lot_id = $2 AND kind = 'outbid' AND status IN ('pending','sending') LIMIT 1`,
    [userId, lot.id])).rowCount;
  const status = inCooldown || pendingAlready ? 'suppressed' : 'pending';
  await db.query(`INSERT INTO auction_sms_messages (user_id, kind, auction_id, lot_id, status, suppress_reason, dedupe_key, phone_last4)
    VALUES ($1,'outbid',$2,$3,$4,$5,$6,$7)`, [userId, lot.auction_id, lot.id, status, status === 'suppressed' ? (inCooldown ? 'cooldown' : 'already_queued') : null,
    'outbid:' + userId + ':' + lot.id + ':' + crypto.randomUUID(), f.u && f.u.phone_verified_e164 ? last4(f.u.phone_verified_e164) : null]);
  return { recorded: status };
}

// ── watched closing ──────────────────────────────────────────────────────────────────────────────────
/** Queue reminders for auctions whose closing starts in about `watched_reminder_minutes`. Idempotent per start time. */
async function scheduleWatchedReminders({ now = new Date() } = {}, deps = {}) {
  const s = await consent.settings();
  if (!s.enabled && !deps.force) return { skipped: 'disabled' };
  const m = s.watched_reminder_minutes;
  const r = await db.query(
    `INSERT INTO auction_sms_messages (user_id, kind, auction_id, closing_start_at, status, dedupe_key)
     SELECT DISTINCT w.user_id, 'watched_closing', a.id, a.start_time, 'pending',
            'watched:' || w.user_id || ':' || a.id || ':' || extract(epoch FROM a.start_time)::bigint
       FROM auctions a JOIN lots l ON l.auction_id = a.id JOIN watchlists w ON w.lot_id = l.id
       JOIN sms_consents c ON c.user_id = w.user_id AND c.sms_type = 'watched_closing' AND c.status = 'opted_in'
      WHERE a.state = ANY($1::text[]) AND a.is_archived IS NOT TRUE AND a.is_demo IS NOT TRUE AND a.start_time IS NOT NULL
        AND a.start_time > $2::timestamptz + interval '15 minutes' AND a.start_time <= $2::timestamptz + ($3 || ' minutes')::interval + interval '5 minutes'
        AND NOT EXISTS (SELECT 1 FROM auction_sms_messages x WHERE x.user_id = w.user_id AND x.auction_id = a.id AND x.kind = 'watched_closing' AND x.status = 'sent')
     ON CONFLICT (dedupe_key) DO NOTHING`, [LIVE_AUCTION_STATES, now.toISOString(), String(m)]);
  return { queued: r.rowCount };
}

// ── sender ───────────────────────────────────────────────────────────────────────────────────────────
/** Claim pending rows, re-check every condition at send time, then send or suppress. Safe to run concurrently. */
async function processPending({ now = new Date(), limit = 50 } = {}, deps = {}) {
  const s = await consent.settings();
  if (!s.enabled && !deps.force) return { skipped: 'disabled' };
  const claimed = (await db.query(`UPDATE auction_sms_messages SET status = 'sending' WHERE id IN (
      SELECT id FROM auction_sms_messages WHERE status = 'pending' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [limit])).rows;
  const out = { sent: 0, suppressed: 0, failed: 0, reasons: {} };
  const finish = async (row, status, reason, extra = {}) => {
    await db.query(`UPDATE auction_sms_messages SET status = $2, suppress_reason = $3, body = COALESCE($4, body), sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
      provider_ref = $5, error = $6 WHERE id = $1`, [row.id, status, reason || null, extra.body || null, extra.ref || null, extra.error || null]);
    out[status === 'sent' ? 'sent' : status === 'failed' ? 'failed' : 'suppressed']++;
    if (reason) out.reasons[reason] = (out.reasons[reason] || 0) + 1;
  };
  for (const row of claimed) {
    try {
      const f = await userFacts(row.user_id, row.kind);
      let decision; let body;
      if (row.kind === 'outbid') {
        const lot = (await db.query(`SELECT id, auction_id, title, lot_number, lot_number_display, state, closes_at, current_winner_user_id FROM lots WHERE id = $1`, [row.lot_id])).rows[0];
        const auction = lot ? (await db.query(`SELECT id, state, is_archived, is_demo FROM auctions WHERE id = $1`, [lot.auction_id])).rows[0] : null;
        const hasBid = lot ? (await db.query(`SELECT 1 FROM bids WHERE lot_id = $1 AND bidder_user_id = $2 LIMIT 1`, [lot.id, row.user_id])).rowCount > 0 : false;
        const last = (await db.query(`SELECT sent_at FROM auction_sms_messages WHERE user_id = $1 AND lot_id = $2 AND kind = 'outbid' AND status = 'sent' AND id <> $3
          ORDER BY sent_at DESC LIMIT 1`, [row.user_id, row.lot_id, row.id])).rows[0];
        decision = decideOutbid({ ...f, lot, auction, userIsHighBidder: !!lot && lot.current_winner_user_id === row.user_id, userHasBid: hasBid,
          createdAt: row.created_at, lastSentAt: last && last.sent_at }, now, s.outbid_cooldown_minutes);
        if (decision.send) body = buildOutbidSms(lot);
      } else {
        const auction = (await db.query(`SELECT id, title, state, is_archived, is_demo, start_time FROM auctions WHERE id = $1`, [row.auction_id])).rows[0];
        const watching = (await db.query(`SELECT 1 FROM watchlists w JOIN lots l ON l.id = w.lot_id WHERE w.user_id = $1 AND l.auction_id = $2 LIMIT 1`, [row.user_id, row.auction_id])).rowCount > 0;
        const alreadySent = (await db.query(`SELECT 1 FROM auction_sms_messages WHERE user_id = $1 AND auction_id = $2 AND kind = 'watched_closing' AND status = 'sent' LIMIT 1`,
          [row.user_id, row.auction_id])).rowCount > 0;
        decision = decideWatchedReminder({ ...f, watching, auction, snapshotStart: row.closing_start_at, alreadySent }, now, s.watched_reminder_minutes);
        if (decision.send) body = buildWatchedSms(auction);
      }
      if (!decision.send) { await finish(row, 'suppressed', decision.reason); continue; }
      const r = await deliver(f.u.phone_verified_e164, body, s, deps);
      if (r.sent) await finish(row, 'sent', null, { body, ref: r.ref });
      else await finish(row, 'suppressed', r.reason || 'not_sent', { body });
    } catch (e) {
      await finish(row, 'failed', 'error', { error: String(e.message).slice(0, 300) }).catch(() => {});
    }
  }
  return out;
}

module.exports = { onOutbid, scheduleWatchedReminders, processPending, decideOutbid, decideWatchedReminder, buildOutbidSms, buildWatchedSms, lotUrl, auctionUrl,
  liveReady, OUTBID_STALE_MINUTES };
