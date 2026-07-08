'use strict';

/**
 * Notification delivery worker.
 *
 * Drains the notifications_queue table on a fixed interval.
 * Fetches user email + preferences, then sends via emailService.
 * SMS delivery is not implemented yet — sms_enabled rows are skipped.
 *
 * Run standalone:
 *   node src/workers/notificationWorker.js
 */

require('dotenv').config();
const Sentry         = require('@sentry/node');
const db             = require('../db/index');
const { sendEmail }  = require('../services/emailService');
const { sendSMS }    = require('../services/smsService');
const auctionService = require('../services/auctionService');
const sellerCloseoutService = require('../services/sellerCloseoutService'); // Design C held seller closeout
const auditService   = require('../services/auditService');
const realtime       = require('../lib/realtime'); // #1 real-time push (pg NOTIFY)
const content        = require('../lib/notificationContent'); // enriched templates + staleness

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'development' });
}

process.on('uncaughtException',  (err)    => { if (process.env.SENTRY_DSN) Sentry.captureException(err); });
process.on('unhandledRejection', (reason) => { if (process.env.SENTRY_DSN) Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason))); });

const SITE_URL = require('../lib/publicUrls').publicBaseUrl();

const POLL_INTERVAL_MS = 5000;
const BATCH_SIZE       = 50;
const MAX_ATTEMPTS     = 5;
const LEASE_TIMEOUT_SEC = 120;   // release a stuck 'processing' lease after a crash

// ── User + preference lookup ───────────────────────────────────────────────────
// Returns { email, email_enabled, sms_enabled, sms_consent, phone_number }.
// If no preferences row exists, email defaults to true; SMS defaults to false.
async function getUserDeliveryInfo(userId) {
  const res = await db.query(
    `SELECT u.email,
            COALESCE(np.email_enabled,  true)  AS email_enabled,
            COALESCE(np.sms_enabled,    false) AS sms_enabled,
            COALESCE(np.sms_consent,    false) AS sms_consent,
            np.phone_number
     FROM users u
     LEFT JOIN notification_preferences np ON np.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  return res.rows[0] || null;
}

// ── Minimal HTML escaper — guards user-supplied strings injected into email HTML ──
function escHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// ── Email content by notification type ────────────────────────────────────────
function buildEmail(type, payload, toAddress) {
  const lotId    = payload.lot_id || 'unknown';
  const cents    = payload.visible_cents != null ? payload.visible_cents : null;
  const price    = cents != null ? `$${(cents / 100).toFixed(2)}` : 'N/A';
  const lotUrl   = `${SITE_URL}/lot.html?lotId=${lotId}`;

  // PICKUP_SCHEDULED — a RECOMMENDED arrival window (not a mandatory appointment). Buyers agreed
  // only to the published pickup window before bidding and keep that flexibility; the optimized
  // window is presented purely as advice to reduce wait times and protect fragile items.
  if (type === 'PICKUP_SCHEDULED') {
    const { fmtTime } = require('../lib/pickupTiers');
    const rf = fmtTime(payload.slot_start), rt = fmtTime(payload.slot_end);
    const wf = payload.window_start ? fmtTime(payload.window_start) : null;
    const wt = payload.window_end ? fmtTime(payload.window_end) : null;
    const winLine = (wf && wt)
      ? `You are welcome to arrive at any time during the published pickup window (${wf} – ${wt}).`
      : 'You are welcome to arrive at any time during the published pickup window.';
    return {
      to: toAddress,
      subject: 'Your recommended pickup arrival window',
      text: `Congratulations on your winning bid!\n\nTo reduce wait times and improve the pickup experience, we recommend arriving between ${rf} and ${rt}.\n\n${winLine}\n\n— Advantage Auction Company`,
      html: `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#111;">
          <div style="background:#111;color:#fff;padding:1rem 1.25rem;border-radius:10px 10px 0 0;font-weight:700;">Advantage.Bid</div>
          <div style="border:1px solid #e4e4e7;border-top:none;border-radius:0 0 10px 10px;padding:1.5rem 1.25rem;">
            <h1 style="font-size:1.15rem;margin:0 0 .6rem;">Your recommended pickup window</h1>
            <p style="font-size:.92rem;line-height:1.6;color:#374151;margin:0 0 .9rem;">Congratulations on your winning bid! To reduce wait times and improve the pickup experience, we recommend arriving between:</p>
            <p style="font-size:1.3rem;font-weight:700;margin:0 0 .9rem;">${rf} &ndash; ${rt}</p>
            <p style="font-size:.9rem;line-height:1.6;color:#374151;margin:0 0 .5rem;">${winLine}</p>
            <p style="font-size:.8rem;color:#71717a;margin:1rem 0 0;">&mdash; Advantage Auction Company</p>
          </div>
        </div>`.trim(),
    };
  }

  if (type === 'OUTBID') {
    return {
      to:      toAddress,
      subject: "You've been outbid",
      text:    `Someone placed a higher bid on a lot you were winning.\n\nLot ID: ${lotId}\nCurrent price: ${price}\n\nPlace a new bid: ${lotUrl}`,
      html:    `
        <p>Someone has placed a higher bid on a lot you were winning.</p>
        <ul>
          <li><strong>Lot ID:</strong> ${lotId}</li>
          <li><strong>Current price:</strong> ${price}</li>
        </ul>
        <p><a href="${lotUrl}">Place a new bid →</a></p>
      `.trim(),
    };
  }

  if (type === 'LEADING') {
    return {
      to:      toAddress,
      subject: "You're currently winning",
      text:    `You are the current high bidder!\n\nLot ID: ${lotId}\nCurrent price: ${price}\n\nView lot: ${lotUrl}`,
      html:    `
        <p>You are the current high bidder!</p>
        <ul>
          <li><strong>Lot ID:</strong> ${lotId}</li>
          <li><strong>Current price:</strong> ${price}</li>
        </ul>
        <p><a href="${lotUrl}">View lot →</a></p>
      `.trim(),
    };
  }

  if (type === 'WINNING') {
    return {
      to:      toAddress,
      subject: "Congratulations — you won!",
      text:    `You won the lot. Proceed to payment to secure your item.\n\nLot ID: ${lotId}\nWinning bid: ${price}\n\nComplete payment: ${lotUrl}`,
      html:    `
        <p>You won the lot. Proceed to payment to secure your item.</p>
        <ul>
          <li><strong>Lot ID:</strong> ${lotId}</li>
          <li><strong>Winning bid:</strong> ${price}</li>
        </ul>
        <p><a href="${lotUrl}">Complete payment →</a></p>
      `.trim(),
    };
  }

  if (type === 'ENDING_SOON') {
    return {
      to:      toAddress,
      subject: "Auction ending soon",
      text:    `A lot you are watching is closing soon.\n\nLot ID: ${lotId}\nCurrent price: ${price}\n\nBid now: ${lotUrl}`,
      html:    `
        <p>A lot you are watching is closing soon.</p>
        <ul>
          <li><strong>Lot ID:</strong> ${lotId}</li>
          <li><strong>Current price:</strong> ${price}</li>
        </ul>
        <p><a href="${lotUrl}">Bid now →</a></p>
      `.trim(),
    };
  }

  if (type === 'CLOSE_TO_WINNING') {
    return {
      to:      toAddress,
      subject: "You're very close to winning",
      text:    `You're very close to winning Lot ${lotId}. A small increase could secure it.\n\nLot ID: ${lotId}\nCurrent price: ${price}\n\nIncrease your bid: ${lotUrl}`,
      html:    `
        <p>You're very close to winning Lot ${lotId}. A small increase could secure it.</p>
        <ul>
          <li><strong>Lot ID:</strong> ${lotId}</li>
          <li><strong>Current price:</strong> ${price}</li>
        </ul>
        <p><a href="${lotUrl}">Increase your bid →</a></p>
      `.trim(),
    };
  }

  if (type === 'FINAL_SECONDS') {
    return {
      to:      toAddress,
      subject: "Final seconds — bid now!",
      text:    `Final seconds for Lot ${lotId} — bid now before it closes.\n\nLot ID: ${lotId}\nCurrent price: ${price}\n\nBid now: ${lotUrl}`,
      html:    `
        <p>Final seconds for Lot ${lotId} — bid now before it closes.</p>
        <ul>
          <li><strong>Lot ID:</strong> ${lotId}</li>
          <li><strong>Current price:</strong> ${price}</li>
        </ul>
        <p><a href="${lotUrl}">Bid now →</a></p>
      `.trim(),
    };
  }

  if (type === 'EXTENDED_BIDDING') {
    return {
      to:      toAddress,
      subject: "Bidding has been extended",
      text:    `Bidding has been extended for Lot ${lotId}. You still have time to win.\n\nLot ID: ${lotId}\nCurrent price: ${price}\n\nPlace your bid: ${lotUrl}`,
      html:    `
        <p>Bidding has been extended for Lot ${lotId}. You still have time to win.</p>
        <ul>
          <li><strong>Lot ID:</strong> ${lotId}</li>
          <li><strong>Current price:</strong> ${price}</li>
        </ul>
        <p><a href="${lotUrl}">Place your bid →</a></p>
      `.trim(),
    };
  }

  if (type === 'NEW_AUCTION') {
    const auctionId   = payload.auction_id || 'unknown';
    const auctionUrl  = `${SITE_URL}${payload.auction_url || `/auction-view.html?auctionId=${auctionId}`}`;
    const title       = payload.title || 'New Auction';
    const lotLine     = payload.lot_count
      ? `<li><strong>Lots available:</strong> ${Number(payload.lot_count)}</li>`
      : '';
    const lotLineTxt  = payload.lot_count
      ? `Lots available: ${Number(payload.lot_count)}\n`
      : '';
    return {
      to:      toAddress,
      subject: `New auction from a seller you follow: ${title}`,
      text:    `A seller you follow has published a new auction.\n\nAuction: ${title}\n${lotLineTxt}\nRegister now to start bidding.\n\nView auction: ${auctionUrl}`,
      html:    `
        <p>A seller you follow has published a new auction.</p>
        <ul>
          <li><strong>Auction:</strong> ${escHtml(title)}</li>
          ${lotLine}
        </ul>
        <p>Register now to start bidding.</p>
        <p><a href="${auctionUrl}">View auction →</a></p>
      `.trim(),
    };
  }

  if (type === 'AUCTION_BEGINS_SOON') {
    // Batch A: engaged-buyer reminder that a bid/watchlisted auction starts soon.
    // Recipients are gated at enqueue time (bidders + watchlisters only).
    const auctionId  = payload.auction_id || 'unknown';
    const auctionUrl = `${SITE_URL}${payload.auction_url || `/auction-view.html?auctionId=${auctionId}`}`;
    const title      = payload.title || 'An auction you follow';
    const mins       = Number(payload.milestone) || null;
    const whenPhrase = mins === 5 ? 'in about 5 minutes' : (mins === 60 ? 'in about an hour' : 'soon');
    return {
      to:      toAddress,
      subject: `Starting ${whenPhrase}: ${title}`,
      text:    `An auction you're following is starting ${whenPhrase}.\n\nAuction: ${title}\n\nGet ready to bid.\n\nView auction: ${auctionUrl}`,
      html:    `
        <p>An auction you're following is starting <strong>${escHtml(whenPhrase)}</strong>.</p>
        <ul>
          <li><strong>Auction:</strong> ${escHtml(title)}</li>
        </ul>
        <p>Get ready to bid.</p>
        <p><a href="${auctionUrl}">View auction →</a></p>
      `.trim(),
    };
  }

  if (type === 'AUCTION_REJECTED') {
    // GOV-REJ: terminal moderation outcome. Quote the operator's reason
    // verbatim so the seller knows exactly what was disqualifying.
    // We deliberately do NOT include a link back to the rejected auction
    // (it's already locked and not editable) — the dashboard is the
    // single source of truth for what the seller can do next.
    const auctionId = payload.auction_id || 'unknown';
    const title     = payload.title      || 'Your auction';
    const reason    = payload.reason     || '';
    const dashUrl   = `${SITE_URL}/seller-dashboard.html`;
    return {
      to:      toAddress,
      subject: `Your auction was not approved: ${title}`,
      text:    `Advantage Auction has reviewed your auction "${title}" and is unable to approve it.\n\nReason: ${reason}\n\nYou may create a new auction submission from your dashboard once you have addressed the feedback above: ${dashUrl}`,
      html:    `
        <p>Advantage Auction has reviewed your auction <strong>${escHtml(title)}</strong> and is unable to approve it.</p>
        <p><strong>Reason from the review team:</strong></p>
        <blockquote style="border-left:3px solid #dc2626; padding-left:12px; color:#333;">${escHtml(reason)}</blockquote>
        <p>You may create a new auction submission from your dashboard once you have addressed the feedback above.</p>
        <p><a href="${dashUrl}">Open my dashboard →</a></p>
      `.trim(),
    };
  }

  if (type === 'AUCTION_RETURNED_TO_DRAFT') {
    // GOV-RET: seller revision request. Quoting the operator's reason verbatim
    // gives the seller actionable correction guidance — the link sends them
    // straight back to their dashboard where the lock will already be lifted.
    const auctionId  = payload.auction_id || 'unknown';
    const title      = payload.title      || 'Your auction';
    const reason     = payload.reason     || '';
    const dashUrl    = `${SITE_URL}/seller-dashboard.html`;
    return {
      to:      toAddress,
      subject: `Revisions requested on your auction: ${title}`,
      text:    `Advantage Auction has returned your auction "${title}" to draft for revisions.\n\nReason: ${reason}\n\nYou can edit your auction and re-submit it from your dashboard: ${dashUrl}`,
      html:    `
        <p>Advantage Auction has returned your auction <strong>${escHtml(title)}</strong> to draft for revisions.</p>
        <p><strong>Reason from the review team:</strong></p>
        <blockquote style="border-left:3px solid #c8a86b; padding-left:12px; color:#333;">${escHtml(reason)}</blockquote>
        <p>You can edit your auction and re-submit it from your dashboard.</p>
        <p><a href="${dashUrl}">Open my dashboard →</a></p>
      `.trim(),
    };
  }

  throw new Error(`Unknown notification type: ${type}`);
}

// ── SMS message content ───────────────────────────────────────────────────────
function buildSMS(type, payload) {
  const lotId  = payload.lot_id || 'unknown';
  const cents  = payload.visible_cents != null ? payload.visible_cents : null;
  const price  = cents != null ? `$${(cents / 100).toFixed(2)}` : 'N/A';
  const link   = `${SITE_URL}/lot.html?lotId=${lotId}`;

  if (type === 'OUTBID') {
    return `You've been outbid. Lot ${lotId} is now ${price}. Bid now: ${link}`;
  }
  if (type === 'LEADING') {
    return `You're winning Lot ${lotId} at ${price}`;
  }
  if (type === 'CLOSE_TO_WINNING') {
    return `You're very close to winning Lot ${lotId} at ${price}. A small increase could secure it.`;
  }

  if (type === 'FINAL_SECONDS') {
    return `Final seconds for Lot ${lotId} — bid now before it closes. Current price: ${price}`;
  }

  if (type === 'EXTENDED_BIDDING') {
    return `Bidding has been extended for Lot ${lotId}. You still have time to win. Current price: ${price}`;
  }

  // WINNING, ENDING_SOON, and NEW_AUCTION are email-only for now.
  return null;
}

// ── Delivery ──────────────────────────────────────────────────────────────────
// Returns { sent: true } on success or { skipped, reason } when intentionally not
// sent (stale / email disabled / lot gone). Throws ONLY on a real failure so the
// caller can back off and retry.
async function deliver(row) {
  const payload = row.payload || {};

  // ── Design C combined payment reminders (#2 +12h / Final #3 +24h) ──
  // deliverQueuedReminder self-skips when the combined invoice is already paid/void
  // (returns { skipped } → marked terminal 'skipped' by deliverOne), else sends the
  // reminder email + bumps reminders_sent. Rows only exist when the combined path
  // ran at close, so this branch is inert under the per-lot default.
  if (row.type === 'PAYMENT_REMINDER') {
    return require('../services/combinedReceiptService').deliverQueuedReminder(row);
  }

  // ── Lot-scoped buyer emails: join lot + auction at SEND time so the message
  // always carries Lot # + Title + image + link, and DROP it if it has gone
  // stale (e.g. an outbid/closing-soon email for a lot that already closed). ──
  if (content.isLotType(row.type)) {
    let lot = null, auction = null;
    if (payload.lot_id) {
      const lr = await db.query(
        `SELECT id, auction_id, lot_number, title, state, current_bid_cents,
                winning_amount_cents, closes_at, extended_until, thumbnail_url
           FROM lots WHERE id = $1`,
        [payload.lot_id]
      );
      lot = lr.rows[0] || null;
      if (lot) {
        const ar = await db.query(`SELECT title, state, end_time FROM auctions WHERE id = $1`, [lot.auction_id]);
        auction = ar.rows[0] || null;
      }
    }
    const rel = content.relevance(row.type, lot, new Date(), auction);
    if (!rel.send) { console.log(`[notify] drop ${row.type} for ${payload.lot_id} — ${rel.reason}`); return { skipped: true, reason: rel.reason }; }

    const userInfo = await getUserDeliveryInfo(row.user_id);
    if (!userInfo) throw new Error(`User ${row.user_id} not found`);
    if (!userInfo.email_enabled) return { skipped: true, reason: 'email disabled' };

    // SMS (opt-in) — best-effort, never affects the queue outcome.
    const smsBody = buildSMS(row.type, payload);
    if (smsBody && userInfo.sms_enabled && userInfo.sms_consent && userInfo.phone_number) {
      sendSMS({ to: userInfo.phone_number, message: smsBody }).catch(err => console.error(`[sms] Failed for user ${row.user_id}:`, err.message));
    }

    console.log(`[notify] ${row.type} → user ${row.user_id} for ${content.lotRef(lot)}`);
    const emailMsg = content.buildLotEmail(row.type, { lot, auction, toAddress: userInfo.email });
    const result = await sendEmail(emailMsg);
    if (result.skipped) throw new Error('SMTP not configured — delivery skipped');
    return { sent: true };
  }

  // ── Non-lot types (auction publish / seller moderation) — legacy builder ──
  console.log(`[notify] ${row.type} → user ${row.user_id} for auction ${payload.auction_id || 'unknown'}`);
  const userInfo = await getUserDeliveryInfo(row.user_id);
  if (!userInfo) throw new Error(`User ${row.user_id} not found`);
  if (!userInfo.email_enabled) return { skipped: true, reason: 'email disabled' };
  const emailMsg = buildEmail(row.type, payload, userInfo.email);
  const result   = await sendEmail(emailMsg);
  if (result.skipped) throw new Error('SMTP not configured — delivery skipped');
  return { sent: true };
}

// ── Core processor ────────────────────────────────────────────────────────────
// A single worker process runs this on an interval. A re-entrancy guard prevents
// overlapping ticks (a slow SES batch must never let the next tick re-select the
// same head-of-queue rows). Rows are CLAIMED atomically with a lease
// (status='processing' + locked_at + FOR UPDATE SKIP LOCKED) so a crash mid-batch
// can be recovered by the reaper rather than stranding rows forever.
let ticking = false;
async function processNotifications() {
  if (ticking) return;           // no overlapping ticks
  ticking = true;
  try {
    // Reaper: release leases stuck in 'processing' past the lease timeout.
    await db.query(
      `UPDATE notifications_queue
          SET status = 'pending', locked_at = NULL
        WHERE status = 'processing'
          AND locked_at < now() - ($1 || ' seconds')::interval`,
      [String(LEASE_TIMEOUT_SEC)]
    ).catch(err => console.error('[notify] reaper error:', err.message));

    // Claim a batch: oldest ready rows (honoring backoff), atomically leased.
    const res = await db.query(
      `UPDATE notifications_queue
          SET status = 'processing', locked_at = now()
        WHERE id IN (
          SELECT id FROM notifications_queue
           WHERE status = 'pending'
             AND attempts < $1
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY created_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [MAX_ATTEMPTS, BATCH_SIZE]
    );
    const rows = res.rows;
    if (!rows.length) return;
    console.log(`[notify] Processing ${rows.length} claimed notification(s)`);
    await Promise.allSettled(rows.map(deliverOne));
  } catch (err) {
    console.error('[notify] processNotifications error:', err.message);
  } finally {
    ticking = false;
  }
}

async function deliverOne(row) {
  try {
    const outcome = await deliver(row);
    if (outcome && outcome.skipped) {
      // Intentionally not sent (stale / disabled / lot gone) — terminal, no retry.
      await db.query(
        `UPDATE notifications_queue SET status = 'skipped', processed_at = now(), last_error = $2, locked_at = NULL WHERE id = $1`,
        [row.id, (outcome.reason || '').slice(0, 500)]
      );
      return;
    }
    await db.query(
      `UPDATE notifications_queue SET status = 'sent', processed_at = now(), attempts = attempts + 1, locked_at = NULL WHERE id = $1`,
      [row.id]
    );
  } catch (err) {
    console.error(`[notify] Failed to deliver ${row.type} to user ${row.user_id}:`, err.message);
    // Exponential backoff (30s, 60s, 120s, 240s, capped 600s) so retries don't
    // churn the head of the queue; give up as 'failed' after MAX_ATTEMPTS.
    const delaySec = Math.min(30 * Math.pow(2, row.attempts || 0), 600);
    await db.query(
      `UPDATE notifications_queue
          SET status          = CASE WHEN attempts + 1 >= $1 THEN 'failed' ELSE 'pending' END,
              attempts        = attempts + 1,
              next_attempt_at = now() + ($3 || ' seconds')::interval,
              last_error      = $4,
              locked_at       = NULL
        WHERE id = $2`,
      [MAX_ATTEMPTS, row.id, String(delaySec), (err.message || '').slice(0, 500)]
    ).catch(updateErr => console.error('[notify] Could not update failed row:', updateErr.message));
  }
}

// ── CLOSE_TO_WINNING scheduler ────────────────────────────────────────────────
const CLOSE_TO_WINNING_INTERVAL_MS = 60_000;   // scan every 60 s
const CLOSE_TO_WINNING_DEDUP_MIN   = 5;        // suppress if already sent within N minutes

async function enqueueCloseToWinning() {
  return; // Batch A: CLOSE_TO_WINNING disabled — never enqueue (unreferenced, kept for rollback).
  try {                                    // eslint-disable-line no-unreachable
    // Bidders whose best bid is >= 90 % of the current price but who are NOT
    // the current winner (they would already receive LEADING notifications).
    // Dedup guard prevents repeat notifications within the dedup window.
    const res = await db.query(
      `INSERT INTO notifications_queue (user_id, type, payload)
       SELECT DISTINCT
              b.bidder_user_id,
              'CLOSE_TO_WINNING',
              jsonb_build_object(
                'lot_id',        l.id::text,
                'visible_cents', l.current_bid_cents,
                'closes_at',     l.closes_at
              )
       FROM   lots l
       JOIN   bids b ON b.lot_id = l.id
                    AND b.amount_cents >= l.current_bid_cents * 0.9
       WHERE  l.state             IN ('open', 'active')
         AND  l.current_bid_cents  > 0
         AND  (l.current_winner_user_id IS NULL OR b.bidder_user_id != l.current_winner_user_id)
         AND  NOT EXISTS (
                SELECT 1
                FROM   notifications_queue nq
                WHERE  nq.user_id            = b.bidder_user_id
                  AND  nq.type               = 'CLOSE_TO_WINNING'
                  AND  nq.payload->>'lot_id' = l.id::text
                  AND  nq.created_at         > NOW() - ($1 || ' minutes')::interval
              )`,
      [CLOSE_TO_WINNING_DEDUP_MIN]
    );

    if (res.rowCount > 0) {
      console.log(`[notify] Queued ${res.rowCount} CLOSE_TO_WINNING notification(s)`);
    }
  } catch (err) {
    console.error('[notify] CLOSE_TO_WINNING scan failed:', err.message);
  }
}

// ── FINAL_SECONDS scheduler ───────────────────────────────────────────────────
const FINAL_SECONDS_INTERVAL_MS = 5_000;   // scan every 5 s

async function enqueueFinalSeconds() {
  return; // Batch A: FINAL_SECONDS disabled — never enqueue (unreferenced, kept for rollback).
  try {                                    // eslint-disable-line no-unreachable
    // Notify every bidder and watcher of a lot that closes within 10 seconds.
    // Dedup is lifetime-per-lot-per-user (no time window) — fire exactly once.
    const res = await db.query(
      `INSERT INTO notifications_queue (user_id, type, payload)
       SELECT DISTINCT
              candidates.user_id,
              'FINAL_SECONDS',
              jsonb_build_object(
                'lot_id',        l.id::text,
                'visible_cents', l.current_bid_cents,
                'closes_at',     l.closes_at
              )
       FROM   lots l
       JOIN   (
                SELECT b.bidder_user_id AS user_id, b.lot_id FROM bids b
                UNION
                SELECT w.user_id, w.lot_id FROM watchlists w
              ) candidates ON candidates.lot_id = l.id
       WHERE  l.state     IN ('open', 'active')
         AND  l.closes_at <= NOW() + INTERVAL '10 seconds'
         AND  NOT EXISTS (
                SELECT 1
                FROM   notifications_queue nq
                WHERE  nq.user_id            = candidates.user_id
                  AND  nq.type               = 'FINAL_SECONDS'
                  AND  nq.payload->>'lot_id' = l.id::text
              )`
    );

    if (res.rowCount > 0) {
      console.log(`[notify] Queued ${res.rowCount} FINAL_SECONDS notification(s)`);
    }
  } catch (err) {
    console.error('[notify] FINAL_SECONDS scan failed:', err.message);
  }
}

// ── ENDING_SOON scheduler ─────────────────────────────────────────────────────
const ENDING_SOON_INTERVAL_MS  = 30_000;   // how often to scan
const ENDING_SOON_WINDOW_MIN   = 10;       // lots closing within N minutes
const ENDING_SOON_DEDUP_MIN    = 5;        // suppress if already queued within N minutes

async function enqueueEndingSoon() {
  return; // Batch A: ENDING_SOON disabled — never enqueue (unreferenced, kept for rollback).
  try {                                    // eslint-disable-line no-unreachable
    // Single INSERT … SELECT with a NOT EXISTS dedup guard.
    // Finds every distinct bidder on any active lot closing within the window,
    // then skips any (user, lot) pair that already has an ENDING_SOON row
    // created within the dedup window.
    const res = await db.query(
      `INSERT INTO notifications_queue (user_id, type, payload)
       SELECT DISTINCT
              candidates.user_id,
              'ENDING_SOON',
              jsonb_build_object(
                'lot_id',        l.id::text,
                'visible_cents', l.current_bid_cents,
                'closes_at',     l.closes_at
              )
       FROM   lots l
       JOIN   (
                -- Engaged bidders: at least one bid within 80% of current price
                SELECT b.bidder_user_id AS user_id, b.lot_id
                FROM   bids b
                WHERE  b.amount_cents >= (
                         SELECT current_bid_cents FROM lots WHERE id = b.lot_id
                       ) * 0.8

                UNION

                -- Watchlist users: following the lot regardless of bid history
                SELECT w.user_id, w.lot_id
                FROM   watchlists w
              ) candidates ON candidates.lot_id = l.id
       WHERE  l.state     IN ('open', 'active')
         AND  l.closes_at BETWEEN NOW()
                               AND NOW() + ($1 || ' minutes')::interval
         AND  NOT EXISTS (
                SELECT 1
                FROM   notifications_queue nq
                WHERE  nq.user_id            = candidates.user_id
                  AND  nq.type               = 'ENDING_SOON'
                  AND  nq.payload->>'lot_id' = l.id::text
                  AND  nq.created_at         > NOW() - ($2 || ' minutes')::interval
              )`,
      [ENDING_SOON_WINDOW_MIN, ENDING_SOON_DEDUP_MIN]
    );

    if (res.rowCount > 0) {
      console.log(`[notify] Queued ${res.rowCount} ENDING_SOON notification(s)`);
    }
  } catch (err) {
    console.error('[notify] ENDING_SOON scan failed:', err.message);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────
// Delivery requires SMTP. If unconfigured, the delivery loop is suppressed so
// pending rows are NOT consumed and permanently marked failed. Enqueueing
// schedulers still run — rows accumulate and will be delivered once SMTP is
// configured and the worker is restarted.
const SMTP_CONFIGURED = !!(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
);

if (SMTP_CONFIGURED) {
  console.log(`[notify] Worker started — polling every ${POLL_INTERVAL_MS / 1000}s`);
  setInterval(processNotifications, POLL_INTERVAL_MS);
  processNotifications();
} else {
  console.warn('[notify] SMTP not configured — delivery paused. Pending rows will be held until SMTP_HOST, SMTP_USER, and SMTP_PASS are set and the worker is restarted.');
}

// Batch A (communication behavior): the individual-lot buyer spam producers —
// ENDING_SOON, CLOSE_TO_WINNING, and FINAL_SECONDS — are DISABLED. Their scheduler
// registrations and initial invocations have been removed so no new rows of these
// types are ever enqueued. The producer functions above are retained (unreferenced)
// for reference/rollback, and each early-returns if ever called. OUTBID, the Design C
// combined payment package, and AUCTION_BEGINS_SOON (below) are the only buyer emails.

// ── AUCTION_BEGINS_SOON scheduler (Batch A) ────────────────────────────────────
// Reminds ENGAGED buyers that an auction they care about is about to start, at two
// milestones (60 min and 5 min before start_time). Recipients are gated to buyers who
// have BID on a lot in the auction OR WATCHLISTED a lot in it — never a broadcast.
const AUCTION_BEGINS_SOON_INTERVAL_MS = 60_000;   // scan every 60 s
const AUCTION_BEGINS_SOON_MILESTONES  = [60, 5];  // minutes-before-start to notify

async function enqueueAuctionBeginsSoon() {
  for (const mins of AUCTION_BEGINS_SOON_MILESTONES) {
    try {
      // For each milestone, enqueue once per (engaged buyer, auction) when the
      // auction's start_time falls within the milestone window. Dedup is
      // lifetime-per-(user, auction, milestone) so each buyer gets at most one
      // 60-min and one 5-min reminder per auction.
      const res = await db.query(
        `INSERT INTO notifications_queue (user_id, type, payload)
         SELECT DISTINCT
                candidates.user_id,
                'AUCTION_BEGINS_SOON',
                jsonb_build_object(
                  'auction_id',  a.id::text,
                  'title',       a.title,
                  'auction_url', '/auction-view.html?auctionId=' || a.id::text,
                  'start_time',  a.start_time,
                  'milestone',   $1::int
                )
         FROM   auctions a
         JOIN   (
                  -- Buyers who bid on any lot in the auction
                  SELECT b.bidder_user_id AS user_id, l.auction_id
                  FROM   bids b JOIN lots l ON l.id = b.lot_id
                  UNION
                  -- Buyers who watchlisted any lot in the auction
                  SELECT w.user_id, l.auction_id
                  FROM   watchlists w JOIN lots l ON l.id = w.lot_id
                ) candidates ON candidates.auction_id = a.id
         WHERE  a.state = 'published'
           AND  a.start_time IS NOT NULL
           AND  a.start_time > NOW()
           AND  a.start_time <= NOW() + ($1 || ' minutes')::interval
           AND  NOT EXISTS (
                  SELECT 1
                  FROM   notifications_queue nq
                  WHERE  nq.user_id               = candidates.user_id
                    AND  nq.type                  = 'AUCTION_BEGINS_SOON'
                    AND  nq.payload->>'auction_id' = a.id::text
                    AND  nq.payload->>'milestone'  = $1::text
                )`,
        [mins]
      );
      if (res.rowCount > 0) {
        console.log(`[notify] Queued ${res.rowCount} AUCTION_BEGINS_SOON (${mins}m) notification(s)`);
      }
    } catch (err) {
      console.error(`[notify] AUCTION_BEGINS_SOON (${mins}m) scan failed:`, err.message);
    }
  }
}

console.log(`[notify] AUCTION_BEGINS_SOON scheduler started — scanning every ${AUCTION_BEGINS_SOON_INTERVAL_MS / 1000}s`);
setInterval(enqueueAuctionBeginsSoon, AUCTION_BEGINS_SOON_INTERVAL_MS);
enqueueAuctionBeginsSoon();

// ── AUCTION_STATE scheduler (PUB-7) ────────────────────────────────────────────
// Time-driven state transitions:
//   published → active    when start_time has arrived
//   active    → closed    when end_time has arrived (delegates to
//                         auctionService.closeAuction for lot-by-lot winner
//                         resolution inside a FOR UPDATE transaction)
//
// NULL start_time or end_time means the auction has no scheduled transition
// from this scheduler's perspective — it stays in its current state until
// either an admin edits the times or moves it manually. This is intentional:
// the seller is the source of truth for scheduling per the governance spec.
async function runAuctionStateTransitions() {
  try {
    // 1. published → active
    const promoted = await db.query(`
      UPDATE auctions
      SET state = 'active', updated_at = NOW()
      WHERE state = 'published'
        AND start_time IS NOT NULL
        AND start_time <= NOW()
      RETURNING id, title
    `);
    if (promoted.rowCount > 0) {
      console.log(`[state-transition] promoted ${promoted.rowCount} auction(s) published → active`);
    }

    // 2. active → closed (delegate to closeAuction for winner resolution).
    //    closeAuction throws 'Auction is already closed' on retry — catch and
    //    move on so a single transient failure does not block the rest of
    //    this tick's work.
    // Close an active auction when its end_time backstop passes OR when every lot has
    // already closed. Without the second condition an auction whose lots all closed
    // before end_time lingers 'active' — showing a misleading "time remaining" countdown
    // on the Browse list while its detail shows all lots closed. Soft-close is respected:
    // an extended lot keeps state='open', so the auction won't close while one is live.
    const due = await db.query(`
      SELECT a.id, a.title FROM auctions a
      WHERE a.state = 'active'
        AND (
          (a.end_time IS NOT NULL AND a.end_time <= NOW())
          OR (
            EXISTS (SELECT 1 FROM lots l WHERE l.auction_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM lots l WHERE l.auction_id = a.id AND l.state = 'open')
          )
        )
    `);
    for (const row of due.rows) {
      try {
        await auctionService.closeAuction(row.id, null /* system actor */);
        console.log(`[state-transition] closed auction ${row.id} (${row.title})`);
      } catch (err) {
        if (!/already closed/i.test(err.message)) {
          console.error(`[state-transition] close failed for ${row.id}: ${err.message}`);
          if (process.env.SENTRY_DSN) Sentry.captureException(err);
        }
      }
    }
  } catch (err) {
    console.error('[state-transition] scheduler error:', err.message);
    if (process.env.SENTRY_DSN) Sentry.captureException(err);
  }
}

const AUCTION_STATE_INTERVAL_MS = 30000;
console.log(`[state-transition] scheduler started — scanning every ${AUCTION_STATE_INTERVAL_MS / 1000}s`);
setInterval(runAuctionStateTransitions, AUCTION_STATE_INTERVAL_MS);
runAuctionStateTransitions();

// ── Design C: HELD seller closeout scan ────────────────────────────────────────
// Under combined invoicing the seller closeout package is NOT sent at close — it is
// held until (A) every buyer has paid OR (B) 24h have elapsed post-close. This scan
// finds auctions still needing it and sends exactly one package, stamping
// auctions.seller_closeout_sent_at as the double-send guard.
//
// The EXISTS (buyer_auction_invoices) predicate means only auctions where the combined
// path actually ran are ever selected — so when the flag was OFF at close (no combined
// rows written), this scan is a permanent no-op. Safe to run unconditionally.
async function runSellerCloseoutScan() {
  let due;
  try {
    due = await db.query(`
      SELECT a.id
        FROM auctions a
       WHERE a.state = 'closed'
         AND a.seller_closeout_sent_at IS NULL
         AND EXISTS (SELECT 1 FROM buyer_auction_invoices b WHERE b.auction_id = a.id)
         AND (
               NOT EXISTS (SELECT 1 FROM buyer_auction_invoices b
                            WHERE b.auction_id = a.id AND b.status = 'payment_required')
               OR EXISTS (SELECT 1 FROM buyer_auction_invoices b
                           WHERE b.auction_id = a.id AND b.closed_at < now() - interval '24 hours')
             )
    `);
  } catch (err) {
    console.error('[seller-closeout] scan failed:', err.message);
    if (process.env.SENTRY_DSN) Sentry.captureException(err);
    return;
  }

  for (const row of due.rows) {
    try {
      await sellerCloseoutService.generateAndSend(row.id);
      await db.query(
        `UPDATE auctions SET seller_closeout_sent_at = now() WHERE id = $1 AND seller_closeout_sent_at IS NULL`,
        [row.id]
      );
      console.log(`[seller-closeout] closeout sent + stamped for auction ${row.id}`);
    } catch (err) {
      console.error(`[seller-closeout] send failed for ${row.id}: ${err.message}`);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    }
  }
}

const SELLER_CLOSEOUT_INTERVAL_MS = 300000;   // 5 min
console.log(`[seller-closeout] scheduler started — scanning every ${SELLER_CLOSEOUT_INTERVAL_MS / 1000}s`);
setInterval(runSellerCloseoutScan, SELLER_CLOSEOUT_INTERVAL_MS);
runSellerCloseoutScan();

// ── INT-1: Lot-level auto-close scheduler ────────────────────────────────────
//
// Each tick, finds open lots whose closes_at has passed and finalizes them
// individually (sets state='closed', records winner). This complements the
// auction-level scheduler:
//   • bidService.applySoftClose bumps both lot.closes_at AND auction.end_time
//     when a bid lands inside the final 2 min, so the auction won't be
//     closed by runAuctionStateTransitions while lots still have time on
//     their clocks.
//   • runLotAutoClose closes any individual lot whose extended window has
//     fully elapsed, even if the auction itself remains 'active' because
//     other lots are still running.
//   • When auction.end_time eventually arrives, runAuctionStateTransitions
//     calls auctionService.closeAuction which iterates lots and is no-op
//     for already-closed ones (WHERE state != 'closed' clause).
//
// Per-lot logic mirrors closeAuction's winner-resolution rule exactly:
// max amount_cents wins, earliest created_at is the tiebreaker. Each lot
// closes in its own transaction with FOR UPDATE so concurrent bid writers
// are serialized cleanly. A race where a bid arrived after the SELECT but
// before the lock would re-check the closes_at and skip the lot, leaving
// it to the next tick.
async function runLotAutoClose() {
  let due;
  try {
    due = await db.query(`
      SELECT l.id
        FROM lots l
        JOIN auctions a ON a.id = l.auction_id
       WHERE l.state = 'open'
         AND l.closes_at IS NOT NULL
         AND l.closes_at <= NOW()
         AND a.state IN ('published', 'active')
    `);
  } catch (err) {
    console.error('[lot-auto-close] scan failed:', err.message);
    if (process.env.SENTRY_DSN) Sentry.captureException(err);
    return;
  }

  for (const row of due.rows) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Re-lock and re-check state inside the transaction. Skip if a writer
      // raced ahead of us (extended closes_at via soft-close, or already
      // closed the lot).
      const lotRes = await client.query(
        `SELECT id, auction_id, lot_number, title, closes_at, state
           FROM lots
          WHERE id = $1
          FOR UPDATE`,
        [row.id]
      );
      const lot = lotRes.rows[0];
      if (!lot || lot.state !== 'open' || !lot.closes_at || new Date(lot.closes_at) > new Date()) {
        await client.query('ROLLBACK');
        continue;
      }

      const bidRes = await client.query(
        `SELECT bidder_user_id, amount_cents
           FROM bids
          WHERE lot_id = $1
          ORDER BY amount_cents DESC, created_at ASC
          LIMIT 1`,
        [lot.id]
      );
      const topBid = bidRes.rows[0];

      if (topBid) {
        await client.query(
          `UPDATE lots
              SET state                 = 'closed',
                  winning_buyer_user_id = $1,
                  winning_amount_cents  = $2
            WHERE id = $3`,
          [topBid.bidder_user_id, topBid.amount_cents, lot.id]
        );
        // Batch A (communication behavior): the per-lot "you won" (WINNING) email
        // has been removed. The buyer's only post-close email is the Design C
        // combined package (per buyer+auction), so no WINNING enqueue at lot close.
      } else {
        await client.query(
          `UPDATE lots SET state = 'closed' WHERE id = $1`,
          [lot.id]
        );
      }

      await auditService.logEvent(client, {
        eventType:  'lot_auto_closed',
        entityType: 'lot',
        entityId:   lot.id,
        auctionId:  lot.auction_id,
        lotId:      lot.id,
        actorId:    null,
        metadata: {
          had_bid:              !!topBid,
          winning_amount_cents: topBid ? topBid.amount_cents : null,
          closes_at:            lot.closes_at,
        },
      });

      await client.query('COMMIT');
      console.log(`[lot-auto-close] closed lot ${lot.id} in auction ${lot.auction_id}, winner=${topBid ? topBid.bidder_user_id : 'none'}`);

      // #1 real-time: notify viewers the lot closed (public payload omits the
      // realized price — clients re-fetch the gated value; targeted lot:winning
      // goes to the winner only).
      realtime.publish('lot', {
        auction_id:     lot.auction_id,
        lot_id:         lot.id,
        lot_number:     lot.lot_number,
        title:          lot.title,
        state:          'closed',
        closes_at:      lot.closes_at,
        winner_user_id: topBid ? topBid.bidder_user_id : null,
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error(`[lot-auto-close] failed for lot ${row.id}: ${err.message}`);
      if (process.env.SENTRY_DSN) Sentry.captureException(err);
    } finally {
      client.release();
    }
  }
}

const LOT_AUTO_CLOSE_INTERVAL_MS = 30000;
console.log(`[lot-auto-close] scheduler started — scanning every ${LOT_AUTO_CLOSE_INTERVAL_MS / 1000}s`);
setInterval(runLotAutoClose, LOT_AUTO_CLOSE_INTERVAL_MS);
runLotAutoClose();
