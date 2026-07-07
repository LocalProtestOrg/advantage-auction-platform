'use strict';

/**
 * combinedInvoiceService — Design C combined per-buyer invoicing domain service.
 *
 * FLAG-INERT (Phase 1): nothing here is wired into auction close or the notification
 * worker. Everything stays dormant until COMBINED_INVOICING_ENABLED='true' is checked
 * at the close hook (Phase 2). The proven per-lot payment path is untouched.
 *
 * One `buyer_auction_invoices` HEADER per (auction, buyer) layers over the existing
 * per-lot `invoices` table (left intact). The header owns the single off-session
 * charge; per-lot invoices are flipped to 'paid' when the combined charge settles.
 *
 * Money is always integer cents. Every mutation is idempotent — a synchronous settle
 * and the Stripe webhook can both fire for the same charge.
 */

const db = require('../db');

// ── Pure helpers (unit-testable, no DB) ──────────────────────────────────────

// Grand total across a buyer's winning lots. Buyer premium / sales tax / shipping
// are $0 at launch; credits SUBTRACT. Accepts an array of lot rows (winning_amount_cents)
// or plain line objects (hammerCents), so it can be unit-tested without a DB.
function computeTotals(lots) {
  const list = Array.isArray(lots) ? lots : [];
  const hammerCents = list.reduce((sum, l) => {
    if (l == null) return sum;
    const v = l.winning_amount_cents != null ? l.winning_amount_cents : l.hammerCents;
    return sum + (Number(v) || 0);
  }, 0);
  const buyerPremiumCents = 0;
  const salesTaxCents = 0;
  const shippingCents = 0;
  const creditsCents = 0;
  const totalCents = hammerCents + buyerPremiumCents + salesTaxCents + shippingCents - creditsCents;
  return { hammerCents, buyerPremiumCents, salesTaxCents, shippingCents, creditsCents, totalCents };
}

// Reminder cadence anchored on auction close (closed_at). Reminder #1 is the
// immediate one sent on the failed synchronous charge; these are the two FUTURE
// fire times enqueued for the worker: +12h (Reminder #2) and +24h (Final notice).
function reminderSchedule(closedAt) {
  const base = new Date(closedAt).getTime();
  const H = 3600 * 1000;
  return [new Date(base + 12 * H), new Date(base + 24 * H)];
}

// Pure status predicate: a combined invoice is "still unpaid" (worth reminding /
// charging) unless it has reached a terminal state.
function isUnpaidStatus(status) {
  return !['paid', 'void'].includes(status);
}

// Pure webhook-branch selector: a combined (null-lot) payment routes to the
// combined settle/fail path; a per-lot payment keeps the existing recordPaymentSuccess
// path. Factored out so the branch decision is unit-testable in isolation.
function isCombinedPayment(payment) {
  return !!payment && (payment.lot_id === null || payment.lot_id === undefined);
}

// ── DB-backed domain operations ──────────────────────────────────────────────

// Aggregate a single buyer's winning-lot totals for an auction.
async function aggregateBuyerTotals(auctionId, buyerUserId) {
  const { rows } = await db.query(
    `SELECT winning_amount_cents
       FROM lots
      WHERE auction_id = $1
        AND winning_buyer_user_id = $2
        AND state = 'closed'
        AND winning_amount_cents IS NOT NULL`,
    [auctionId, buyerUserId]
  );
  return computeTotals(rows);
}

// Issue (UPSERT) one combined header per distinct winning buyer in the auction.
// Idempotent: ON CONFLICT DO NOTHING then read back. Totals + closed_at are set
// on first insert and left untouched on re-run. Returns
// [{ combinedInvoiceId, buyerUserId, totalCents }].
async function issueForAuction(auctionId) {
  const { rows: buyers } = await db.query(
    `SELECT DISTINCT winning_buyer_user_id AS buyer_user_id
       FROM lots
      WHERE auction_id = $1
        AND state = 'closed'
        AND winning_buyer_user_id IS NOT NULL
        AND winning_amount_cents IS NOT NULL`,
    [auctionId]
  );

  const results = [];
  for (const b of buyers) {
    const totals = await aggregateBuyerTotals(auctionId, b.buyer_user_id);
    const ins = await db.query(
      `INSERT INTO buyer_auction_invoices
         (auction_id, buyer_user_id, hammer_cents, buyer_premium_cents,
          sales_tax_cents, shipping_cents, credits_cents, total_cents, status, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'issued', now())
       ON CONFLICT (auction_id, buyer_user_id) DO NOTHING
       RETURNING id, total_cents`,
      [auctionId, b.buyer_user_id, totals.hammerCents, totals.buyerPremiumCents,
       totals.salesTaxCents, totals.shippingCents, totals.creditsCents, totals.totalCents]
    );
    let row = ins.rows[0];
    if (!row) {
      row = (await db.query(
        `SELECT id, total_cents FROM buyer_auction_invoices
          WHERE auction_id = $1 AND buyer_user_id = $2`,
        [auctionId, b.buyer_user_id]
      )).rows[0];
    }
    if (row) {
      results.push({ combinedInvoiceId: row.id, buyerUserId: b.buyer_user_id, totalCents: row.total_cents });
    }
  }
  return results;
}

// Settle a combined charge in ONE transaction. Idempotent (no-op if already paid):
//   - header  → paid, paid_at, payment_id, stripe_payment_intent_id
//   - payment → paid, charged_at  (guarded so a paid row is never re-touched)
//   - per-lot invoices for this (auction, buyer) → paid, payment_id
// so admin views + the pickup packet stay correct.
async function settleCombined(combinedInvoiceId, stripePaymentIntentId, paymentId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `SELECT id, auction_id, buyer_user_id, status
         FROM buyer_auction_invoices WHERE id = $1 FOR UPDATE`,
      [combinedInvoiceId]
    );
    const bai = res.rows[0];
    if (!bai) {
      await client.query('ROLLBACK');
      throw new Error('Combined invoice not found: ' + combinedInvoiceId);
    }
    if (bai.status === 'paid') {
      await client.query('ROLLBACK');
      return { alreadyPaid: true };
    }

    await client.query(
      `UPDATE buyer_auction_invoices
          SET status = 'paid',
              paid_at = now(),
              payment_id = COALESCE($2, payment_id),
              stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
              updated_at = now()
        WHERE id = $1`,
      [combinedInvoiceId, paymentId || null, stripePaymentIntentId || null]
    );

    if (paymentId) {
      await client.query(
        `UPDATE payments
            SET status = 'paid', charged_at = now(), last_attempted_at = now()
          WHERE id = $1 AND status <> 'paid'`,
        [paymentId]
      );
    }

    // Flip this buyer's per-lot invoices for the auction to paid so admin views +
    // the pickup packet (which read the per-lot `invoices` table) stay correct.
    await client.query(
      `UPDATE invoices
          SET status = 'paid', payment_id = COALESCE($3, payment_id)
        WHERE auction_id = $1 AND buyer_user_id = $2 AND status <> 'paid'`,
      [bai.auction_id, bai.buyer_user_id, paymentId || null]
    );

    await client.query('COMMIT');
    return { settled: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Mark a combined header payment_required (charge failed / no card). Idempotent:
// never downgrades a paid/void header, and reminders_sent floors at 1 (Reminder #1
// is the immediate email). Returns the row.
async function markFailed(combinedInvoiceId, reason) {
  const { rows } = await db.query(
    `UPDATE buyer_auction_invoices
        SET status = CASE WHEN status IN ('paid', 'void') THEN status ELSE 'payment_required' END,
            charge_attempted_at = now(),
            reminders_sent = GREATEST(reminders_sent, 1),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [combinedInvoiceId]
  );
  if (reason) console.log(`[combined] markFailed ${combinedInvoiceId} — ${reason}`);
  return rows[0];
}

// Whether a header is still worth reminding/charging (status NOT terminal).
async function stillUnpaid(combinedInvoiceId) {
  const { rows } = await db.query(
    `SELECT status FROM buyer_auction_invoices WHERE id = $1`,
    [combinedInvoiceId]
  );
  if (!rows[0]) return false;
  return isUnpaidStatus(rows[0].status);
}

module.exports = {
  // pure
  computeTotals,
  reminderSchedule,
  isUnpaidStatus,
  isCombinedPayment,
  // db-backed
  aggregateBuyerTotals,
  issueForAuction,
  settleCombined,
  markFailed,
  stillUnpaid,
};
