-- 179: Invoice status follows a refund (2026-09-28). ADDITIVE / IDEMPOTENT. Moves no money.
-- A refunded payment left the buyer's invoices saying "paid". Combined invoices gain the two refund states the per-lot
-- invoices and the buyer/admin pages already understand; existing refunded payments are backfilled once.
ALTER TABLE buyer_auction_invoices DROP CONSTRAINT IF EXISTS buyer_auction_invoices_status_check;
ALTER TABLE buyer_auction_invoices ADD CONSTRAINT buyer_auction_invoices_status_check
  CHECK (status IN ('issued', 'payment_required', 'paid', 'void', 'refunded', 'partially_refunded'));

-- Backfill (same rule as src/services/invoiceRefundStatus.js): full refund → 'refunded'; partial → 'partially_refunded'.
UPDATE invoices i SET status = 'refunded'
  FROM payments p WHERE i.payment_id = p.id AND p.status = 'refunded' AND i.status IN ('paid', 'partially_refunded');
UPDATE invoices i SET status = 'partially_refunded'
  FROM payments p WHERE i.payment_id = p.id AND p.status = 'partially_refunded' AND i.status = 'paid';
UPDATE buyer_auction_invoices b SET status = 'refunded', updated_at = now()
  FROM payments p WHERE b.payment_id = p.id AND p.status = 'refunded' AND b.status IN ('paid', 'partially_refunded');
UPDATE buyer_auction_invoices b SET status = 'partially_refunded', updated_at = now()
  FROM payments p WHERE b.payment_id = p.id AND p.status = 'partially_refunded' AND b.status = 'paid';
