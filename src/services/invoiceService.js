const db = require('../db');
const billingTerms = require('./billingTermsService');

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
async function createIssuedInvoice(client, { auctionId, lotId, buyerUserId, amountCents, buyerPremiumCents }) {
  const hammer = amountCents || 0;
  const premium = buyerPremiumCents || 0;              // authoritative lot-level buyer premium (0 for legacy callers)
  const total = hammer + premium;
  const { rows } = await (client || db).query(
    `INSERT INTO invoices
       (payment_id, buyer_user_id, auction_id, lot_id, amount_cents,
        hammer_cents, buyer_premium_cents, sales_tax_cents, shipping_cents, total_cents, status)
     VALUES (NULL, $1, $2, $3, $4,
             $5, $6, 0, 0, $4, 'issued')
     ON CONFLICT (lot_id, buyer_user_id) DO NOTHING
     RETURNING *`,
    [buyerUserId, auctionId, lotId, total, hammer, premium]
  );
  return rows[0]; // undefined if it already existed
}

// Settle the invoice for a successful payment. UPSERT on (lot_id, buyer_user_id):
// - no prior invoice  → insert a 'paid' invoice (fresh invoice_number from the seq)
// - prior 'issued'    → update IT to 'paid' + link payment_id, KEEPING its
//                       invoice_number (not in the SET list, so it is preserved)
// Always called from recordPaymentSuccess after the payment row is 'paid'.
async function createInvoice(client, payment) {
  const amount = payment.amount_cents;                 // what the buyer actually paid = base + sales tax
  const tax    = payment.sales_tax_cents || 0;         // Stripe Tax (0 when the tax feature is disabled)
  const baseForInsert = Math.max(0, amount - tax);     // hammer+premium fallback used ONLY when no issued invoice exists
  const { rows } = await (client || db).query(
    `INSERT INTO invoices
       (payment_id, buyer_user_id, auction_id, lot_id, amount_cents,
        hammer_cents, buyer_premium_cents, sales_tax_cents, shipping_cents, total_cents, status)
     VALUES ($1, $2, $3, $4, $5,
             $6, 0, $7, 0, $5, 'paid')
     ON CONFLICT (lot_id, buyer_user_id) DO UPDATE
       -- Preserve the authoritative hammer / buyer_premium split written at issuance; a payment-success
       -- links the payment, flips status, and records the sales tax actually charged (total/amount grow
       -- by that tax). When tax is disabled sales_tax_cents=0, so amount/total are unchanged vs issuance.
       SET status          = 'paid',
           payment_id      = EXCLUDED.payment_id,
           sales_tax_cents = EXCLUDED.sales_tax_cents,
           amount_cents    = EXCLUDED.amount_cents,
           total_cents     = EXCLUDED.total_cents
     RETURNING *`,
    [payment.id, payment.buyer_user_id, payment.auction_id, payment.lot_id, amount, baseForInsert, tax]
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
  // Effective buyer-premium bps for THIS auction (individual → fixed 18%; professional → their rate).
  // Resolved once; each lot's premium is computed from its own hammer via the authoritative model.
  const terms = await billingTerms.resolveEffectiveTerms(auctionId);
  const createdIds = [];
  for (const w of winners) {
    try {
      const inv = await createIssuedInvoice(null, {
        auctionId,
        lotId: w.lot_id,
        buyerUserId: w.buyer_user_id,
        amountCents: w.winning_amount_cents,
        buyerPremiumCents: billingTerms.lotBuyerPremiumCents(w.winning_amount_cents, terms.buyer_premium_bps),
      });
      if (inv && inv.id) createdIds.push(inv.id);
    } catch (e) {
      console.error(`[invoice] issued-invoice create failed for lot ${w.lot_id}:`, e.message);
    }
  }
  return { winnerCount: winners.length, createdIds, existingCount: winners.length - createdIds.length };
}

module.exports = { createInvoice, createIssuedInvoice, issueInvoicesForAuctionWinners };
