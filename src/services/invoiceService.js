const db = require('../db');

async function createInvoice(client, payment) {
  const { rows } = await (client || db).query(
    `INSERT INTO invoices (payment_id, buyer_user_id, auction_id, lot_id, amount_cents, status)
     VALUES ($1, $2, $3, $4, $5, 'issued')
     RETURNING *`,
    [payment.id, payment.buyer_user_id, payment.auction_id, payment.lot_id, payment.amount_cents]
  );
  return rows[0];
}

module.exports = { createInvoice };
