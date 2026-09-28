-- 174: Professional Storefront (fixed-price Marketplace) checkout hardening.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Supports: payment-conflict auto-refunds (a charge that succeeded after the
-- order's hold was lost is refunded automatically and the reason recorded), partial / out-of-app refunds, a manual
-- review flag for money states that need a person (e.g. a partial refund that changes seller proceeds or a tax
-- reversal that could not be recorded), and the expired-hold sweeper's lookup. No money is moved by this migration.

-- Refund state gains 'partially_refunded' (the order stays paid; refunded_amount_cents carries the cumulative total).
ALTER TABLE marketplace_orders DROP CONSTRAINT IF EXISTS marketplace_orders_refund_status_check;
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_refund_status_check
  CHECK (refund_status IN ('none','partially_refunded','refunded'));

-- Why the order was refunded when the platform refunded it automatically (e.g. 'conflict:item_sold').
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS refund_reason  TEXT;
-- Admin attention flag (never moves money; settlement stays manual).
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS review_note     TEXT;

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_review ON marketplace_orders (review_required) WHERE review_required = true;
-- Expired-hold sweeper lookup.
CREATE INDEX IF NOT EXISTS idx_marketplace_items_pending_expiry
  ON marketplace_items (pending_expires_at) WHERE status = 'pending_purchase';
