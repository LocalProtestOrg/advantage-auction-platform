'use strict';

/**
 * invoiceRefundStatus — keep an auction buyer's invoices in step with a refunded payment.
 *
 * A refund (issued in the app via processRefund, or outside it and reported by the charge.refunded webhook) updates
 * the payment row. Without this, the buyer's invoices kept saying "paid" after a full refund. The invoices now follow:
 *   payment 'refunded'           → invoices 'refunded'
 *   payment 'partially_refunded' → invoices 'partially_refunded'
 * Covers the per-lot invoices (invoices.payment_id) and the combined header (buyer_auction_invoices.payment_id).
 * Only a paid (or partially refunded) invoice changes — never an issued/unpaid/void one — and nothing moves money.
 *
 * Money semantics are unchanged: a refunded invoice still counts as COLLECTED (the refund itself is subtracted from
 * the payment's refunded_amount_cents), so settlement never double-counts a refund.
 */

const REFUND_STATES = ['refunded', 'partially_refunded'];
// Invoice states that mean "the buyer paid" (fully kept, partly refunded, or fully refunded).
const COLLECTED_INVOICE_STATES = ['paid', 'partially_refunded', 'refunded'];

/**
 * Sync invoice statuses for one payment. Pass the transaction client (and the status just written) when the payment
 * row was updated in that transaction.
 * Returns { status, invoices, combined } — the invoice status applied and how many rows changed.
 */
async function syncInvoicesForPayment(runner, paymentId, knownStatus) {
  // Callers that just wrote the payment pass its new status; otherwise it is read.
  const status = knownStatus || ((await runner.query('SELECT status FROM payments WHERE id = $1', [paymentId])).rows[0] || {}).status;
  if (!REFUND_STATES.includes(status)) return { status: null, invoices: 0, combined: 0 };
  const target = status;
  // A full refund also upgrades an earlier partial one; a partial refund never downgrades a full one.
  const from = target === 'refunded' ? ['paid', 'partially_refunded'] : ['paid'];
  const inv = await runner.query(
    `UPDATE invoices SET status = $2 WHERE payment_id = $1 AND status = ANY($3::text[])`, [paymentId, target, from]);
  const bai = await runner.query(
    `UPDATE buyer_auction_invoices SET status = $2, updated_at = now() WHERE payment_id = $1 AND status = ANY($3::text[])`,
    [paymentId, target, from]);
  return { status: target, invoices: inv.rowCount || 0, combined: bai.rowCount || 0 };
}

module.exports = { syncInvoicesForPayment, REFUND_STATES, COLLECTED_INVOICE_STATES };
