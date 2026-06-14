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
        const ar = await db.query(`SELECT title FROM auctions WHERE id = $1`, [lot.auction_id]);
        auction = ar.rows[0] || null;
      }
    }
    const rel = content.relevance(row.type, lot, new Date());
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
  try {
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
  try {
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
  try {
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

console.log(`[notify] ENDING_SOON scheduler started — scanning every ${ENDING_SOON_INTERVAL_MS / 1000}s`);
setInterval(enqueueEndingSoon, ENDING_SOON_INTERVAL_MS);

console.log(`[notify] CLOSE_TO_WINNING scheduler started — scanning every ${CLOSE_TO_WINNING_INTERVAL_MS / 1000}s`);
setInterval(enqueueCloseToWinning, CLOSE_TO_WINNING_INTERVAL_MS);

console.log(`[notify] FINAL_SECONDS scheduler started — scanning every ${FINAL_SECONDS_INTERVAL_MS / 1000}s`);
setInterval(enqueueFinalSeconds, FINAL_SECONDS_INTERVAL_MS);

enqueueEndingSoon();
enqueueCloseToWinning();
enqueueFinalSeconds();

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
    const due = await db.query(`
      SELECT id, title FROM auctions
      WHERE state = 'active'
        AND end_time IS NOT NULL
        AND end_time <= NOW()
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
