const db = require('../db');

// Phase 2C: invoices are keyed by the natural pair (lot_id, buyer_user_id) — a lot
// has a single winner, so that pair uniquely identifies a buyer's invoice. This lets
// us (a) auto-create an unpaid 'issued' invoice at auction close and (b) UPSERT the
// SAME row to 'paid' on payment success — never a duplicate, with a stable
// invoice_number. amount == hammer == total today (hammer-only charging);
// buyer_premium / sales_tax / shipping stay 0 until those features activate.

// Create an unpaid invoice for a winning lot (called at auction close). Idempotent:
// if one already exists for (lot_id, buyer_user_id) it is left untouched. Returns
// the row ONLY when newly inserted (so the caller can email just the new ones);
// returns undefined when an invoice already existed.
async function createIssuedInvoice(client, { auctionId, lotId, buyerUserId, amountCents }) {
  const amount = amountCents || 0;
  const { rows } = await (client || db).query(
    `INSERT INTO invoices
       (payment_id, buyer_user_id, auction_id, lot_id, amount_cents,
        hammer_cents, buyer_premium_cents, sales_tax_cents, shipping_cents, total_cents, status)
     VALUES (NULL, $1, $2, $3, $4,
             $4, 0, 0, 0, $4, 'issued')
     ON CONFLICT (lot_id, buyer_user_id) DO NOTHING
     RETURNING *`,
    [buyerUserId, auctionId, lotId, amount]
  );
  return rows[0]; // undefined if it already existed
}

// Settle the invoice for a successful payment. UPSERT on (lot_id, buyer_user_id):
// - no prior invoice  → insert a 'paid' invoice (fresh invoice_number from the seq)
// - prior 'issued'    → update IT to 'paid' + link payment_id, KEEPING its
//                       invoice_number (not in the SET list, so it is preserved)
// Always called from recordPaymentSuccess after the payment row is 'paid'.
async function createInvoice(client, payment) {
  const amount = payment.amount_cents;
  const { rows } = await (client || db).query(
    `INSERT INTO invoices
       (payment_id, buyer_user_id, auction_id, lot_id, amount_cents,
        hammer_cents, buyer_premium_cents, sales_tax_cents, shipping_cents, total_cents, status)
     VALUES ($1, $2, $3, $4, $5,
             $5, 0, 0, 0, $5, 'paid')
     ON CONFLICT (lot_id, buyer_user_id) DO UPDATE
       SET status       = 'paid',
           payment_id   = EXCLUDED.payment_id,
           amount_cents = EXCLUDED.amount_cents,
           hammer_cents = EXCLUDED.hammer_cents,
           total_cents  = EXCLUDED.total_cents
     RETURNING *`,
    [payment.id, payment.buyer_user_id, payment.auction_id, payment.lot_id, amount]
  );
  return rows[0];
}

// Ensure every winning lot of an auction has an invoice (unpaid 'issued' unless one
// already exists). Idempotent and pool-based (no shared transaction), so it is safe to
// run both POST-COMMIT after close AND as an admin repair/retry afterwards. Reads
// committed winning lots directly, so it does not depend on any in-memory results.
// Returns { winnerCount, createdIds, existingCount }. Invoice generation only.
async function issueInvoicesForAuctionWinners(auctionId) {
  const { rows: winners } = await db.query(
    `SELECT id AS lot_id, winning_buyer_user_id AS buyer_user_id, winning_amount_cents
       FROM lots
      WHERE auction_id = $1
        AND state = 'closed'
        AND winning_buyer_user_id IS NOT NULL
        AND winning_amount_cents IS NOT NULL`,
    [auctionId]
  );
  const createdIds = [];
  for (const w of winners) {
    try {
      const inv = await createIssuedInvoice(null, {
        auctionId,
        lotId: w.lot_id,
        buyerUserId: w.buyer_user_id,
        amountCents: w.winning_amount_cents,
      });
      if (inv && inv.id) createdIds.push(inv.id);
    } catch (e) {
      console.error(`[invoice] issued-invoice create failed for lot ${w.lot_id}:`, e.message);
    }
  }
  return { winnerCount: winners.length, createdIds, existingCount: winners.length - createdIds.length };
}

module.exports = { createInvoice, createIssuedInvoice, issueInvoicesForAuctionWinners };
