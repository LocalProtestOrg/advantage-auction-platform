const db = require('../db');

// Status mirrors the payment that triggered the invoice.
// createInvoice is only called from recordPaymentSuccess (after the payment row
// is updated to 'paid'), so the invoice is always created with status='paid'.
// Passing payment.status explicitly keeps this function honest about its contract
// and makes future call sites self-documenting.
async function createInvoice(client, payment) {
  const status = payment.status === 'paid' ? 'paid' : 'issued';
  // Phase 2: persist the invoice breakdown. Today the buyer is charged hammer
  // only, so amount == hammer == total and premium/tax/shipping are 0. invoice_number
  // (sequence default) and invoice_date (default now) are assigned by the DB.
  const amount = payment.amount_cents;
  const { rows } = await (client || db).query(
    `INSERT INTO invoices
       (payment_id, buyer_user_id, auction_id, lot_id, amount_cents,
        hammer_cents, buyer_premium_cents, sales_tax_cents, shipping_cents, total_cents, status)
     VALUES ($1, $2, $3, $4, $5,
             $5, 0, 0, 0, $5, $6)
     RETURNING *`,
    [payment.id, payment.buyer_user_id, payment.auction_id, payment.lot_id, amount, status]
  );
  return rows[0];
}

module.exports = { createInvoice };
