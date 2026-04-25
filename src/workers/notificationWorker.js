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
const db            = require('../db/index');
const { sendEmail } = require('../services/emailService');
const { sendSMS }   = require('../services/smsService');

const POLL_INTERVAL_MS = 5000;
const BATCH_SIZE       = 50;
const MAX_ATTEMPTS     = 3;

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

// ── Email content by notification type ────────────────────────────────────────
function buildEmail(type, payload, toAddress) {
  const lotId    = payload.lot_id || 'unknown';
  const cents    = payload.visible_cents != null ? payload.visible_cents : null;
  const price    = cents != null ? `$${(cents / 100).toFixed(2)}` : 'N/A';
  const lotUrl   = `https://advantageauction.bid/lot.html?lotId=${lotId}`;

  if (type === 'OUTBID') {
    return {
      to:      toAddress,
      subject: "You've been outbid",
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

  throw new Error(`Unknown notification type: ${type}`);
}

// ── SMS message content ───────────────────────────────────────────────────────
function buildSMS(type, payload) {
  const lotId  = payload.lot_id || 'unknown';
  const cents  = payload.visible_cents != null ? payload.visible_cents : null;
  const price  = cents != null ? `$${(cents / 100).toFixed(2)}` : 'N/A';
  const link   = `https://advantageauction.bid/lot.html?lotId=${lotId}`;

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

  // WINNING and ENDING_SOON are email-only for now; SMS not required by spec.
  return null;
}

// ── Delivery ──────────────────────────────────────────────────────────────────
async function deliver(row) {
  const payload = row.payload || {};
  const lotId   = payload.lot_id || 'unknown-lot';
  const price   = payload.visible_cents != null
    ? ` @ $${(payload.visible_cents / 100).toFixed(2)}`
    : '';

  console.log(`[notify] ${row.type} → user ${row.user_id} for lot ${lotId}${price}`);

  const userInfo = await getUserDeliveryInfo(row.user_id);
  if (!userInfo) {
    throw new Error(`User ${row.user_id} not found`);
  }

  // ── SMS — fires independently, never affects queue row outcome ──
  const smsBody = buildSMS(row.type, payload);
  if (
    smsBody &&
    userInfo.sms_enabled &&
    userInfo.sms_consent &&
    userInfo.phone_number
  ) {
    sendSMS({ to: userInfo.phone_number, message: smsBody }).catch(err => {
      console.error(`[sms] Failed for user ${row.user_id}:`, err.message);
    });
  }

  // ── Email — determines queue success/failure; must throw on any problem ──
  if (!userInfo.email_enabled) {
    throw new Error(`Email disabled for user ${row.user_id}`);
  }

  const emailMsg = buildEmail(row.type, payload, userInfo.email);
  const result   = await sendEmail(emailMsg);

  if (result.skipped) {
    throw new Error('SMTP not configured — delivery skipped');
  }
}

// ── Core processor ────────────────────────────────────────────────────────────
async function processNotifications() {
  let rows;
  try {
    const res = await db.query(
      `SELECT * FROM notifications_queue
       WHERE status = 'pending'
         AND attempts < $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [MAX_ATTEMPTS, BATCH_SIZE]
    );
    rows = res.rows;
  } catch (err) {
    console.error('[notify] Failed to query notifications_queue:', err.message);
    return;
  }

  if (!rows.length) return;

  console.log(`[notify] Processing ${rows.length} pending notification(s)`);

  await Promise.allSettled(
    rows.map(row => deliverOne(row))
  );
}

async function deliverOne(row) {
  try {
    await deliver(row);

    await db.query(
      `UPDATE notifications_queue
       SET status   = 'sent',
           attempts = attempts + 1
       WHERE id = $1`,
      [row.id]
    );
  } catch (err) {
    console.error(`[notify] Failed to deliver ${row.type} to user ${row.user_id}:`, err.message);

    await db.query(
      `UPDATE notifications_queue
       SET status   = CASE WHEN attempts + 1 >= $1 THEN 'failed' ELSE 'pending' END,
           attempts = attempts + 1
       WHERE id = $2`,
      [MAX_ATTEMPTS, row.id]
    ).catch(updateErr => {
      console.error('[notify] Could not update failed row:', updateErr.message);
    });
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
              b.user_id,
              'CLOSE_TO_WINNING',
              jsonb_build_object(
                'lot_id',        l.id::text,
                'visible_cents', l.current_bid_cents,
                'closes_at',     l.closes_at
              )
       FROM   lots l
       JOIN   bids b ON b.lot_id = l.id
                    AND b.amount * 100 >= l.current_bid_cents * 0.9
       WHERE  l.status            = 'active'
         AND  l.current_bid_cents  > 0
         AND  (l.current_winner_user_id IS NULL OR b.user_id != l.current_winner_user_id)
         AND  NOT EXISTS (
                SELECT 1
                FROM   notifications_queue nq
                WHERE  nq.user_id            = b.user_id
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
                SELECT b.user_id, b.lot_id FROM bids b
                UNION
                SELECT w.user_id, w.lot_id FROM watchlists w
              ) candidates ON candidates.lot_id = l.id
       WHERE  l.status    = 'active'
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
                SELECT b.user_id, b.lot_id
                FROM   bids b
                WHERE  b.amount * 100 >= (
                         SELECT current_bid_cents FROM lots WHERE id = b.lot_id
                       ) * 0.8

                UNION

                -- Watchlist users: following the lot regardless of bid history
                SELECT w.user_id, w.lot_id
                FROM   watchlists w
              ) candidates ON candidates.lot_id = l.id
       WHERE  l.status    = 'active'
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
console.log(`[notify] Worker started — polling every ${POLL_INTERVAL_MS / 1000}s`);
setInterval(processNotifications, POLL_INTERVAL_MS);

console.log(`[notify] ENDING_SOON scheduler started — scanning every ${ENDING_SOON_INTERVAL_MS / 1000}s`);
setInterval(enqueueEndingSoon, ENDING_SOON_INTERVAL_MS);

console.log(`[notify] CLOSE_TO_WINNING scheduler started — scanning every ${CLOSE_TO_WINNING_INTERVAL_MS / 1000}s`);
setInterval(enqueueCloseToWinning, CLOSE_TO_WINNING_INTERVAL_MS);

console.log(`[notify] FINAL_SECONDS scheduler started — scanning every ${FINAL_SECONDS_INTERVAL_MS / 1000}s`);
setInterval(enqueueFinalSeconds, FINAL_SECONDS_INTERVAL_MS);

// Run once immediately on startup so first batch isn't delayed.
processNotifications();
enqueueEndingSoon();
enqueueCloseToWinning();
enqueueFinalSeconds();
