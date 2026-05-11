const db = require('../db');

// Status mirrors the payment that triggered the invoice.
// createInvoice is only called from recordPaymentSuccess (after the payment row
// is updated to 'paid'), so the invoice is always created with status='paid'.
// Passing payment.status explicitly keeps this function honest about its contract
// and makes future call sites self-documenting.
async function createInvoice(client, payment) {
  const status = payment.status === 'paid' ? 'paid' : 'issued';
  const { rows } = await (client || db).query(
    `INSERT INTO invoices (payment_id, buyer_user_id, auction_id, lot_id, amount_cents, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [payment.id, payment.buyer_user_id, payment.auction_id, payment.lot_id, payment.amount_cents, status]
  );
  return rows[0];
}

module.exports = { createInvoice };
