-- 121: Fixed-price Marketplace Buy Now — order model + one-of-one inventory concurrency.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Introduces marketplace_orders (the retail order record, kept
-- SEPARATE from auction `payments`/`buyer_auction_invoices` which are hammer/premium-specific) and the
-- inventory 'pending_purchase' state that lets a single one-of-one item be claimed atomically at checkout.
-- Does NOT touch auctions, bids, lots, payments, settlement, or the storefront layer.

-- ── Inventory: add the checkout-claim state + claim bookkeeping ────────────────────────────────────────
-- 'pending_purchase' = a buyer holds this one-of-one item during an in-flight checkout (non-public). The
-- claim carries an expiry so an abandoned/failed checkout is safely reclaimable (never a permanent lock).
ALTER TABLE marketplace_items DROP CONSTRAINT IF EXISTS marketplace_items_status_check;
ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_status_check
  CHECK (status IN ('draft','active','pending_purchase','sold','removed'));
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pending_order_id   UUID;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pending_expires_at TIMESTAMPTZ;

-- ── Human-readable order number sequence (MO-001001, MO-001002, …) ────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS marketplace_order_number_seq START 1001;

-- ── Marketplace orders (retail order = one purchasable item; all money is server-authoritative cents) ──
CREATE TABLE IF NOT EXISTS marketplace_orders (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number             TEXT UNIQUE NOT NULL
                             DEFAULT ('MO-' || lpad(nextval('marketplace_order_number_seq')::text, 6, '0')),
  marketplace_item_id      UUID NOT NULL REFERENCES marketplace_items(id) ON DELETE RESTRICT,
  seller_id                UUID NOT NULL REFERENCES seller_profiles(id)   ON DELETE RESTRICT,
  buyer_user_id            UUID NOT NULL REFERENCES users(id)             ON DELETE RESTRICT,
  -- Money snapshot at order time. platform fee applies to the ITEM PRICE (not tax, not shipping);
  -- seller proceeds = item_price + shipping - platform_fee; sales tax is NEVER seller proceeds.
  item_price_cents         INTEGER NOT NULL CHECK (item_price_cents >= 0),
  shipping_cents           INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  tax_cents                INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  platform_fee_bps         INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents       INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  seller_proceeds_cents    INTEGER NOT NULL DEFAULT 0,
  total_charge_cents       INTEGER NOT NULL CHECK (total_charge_cents >= 0),
  currency                 TEXT NOT NULL DEFAULT 'usd',
  -- Fulfillment
  fulfillment_method       TEXT NOT NULL CHECK (fulfillment_method IN ('pickup','shipping')),
  ship_to                  JSONB,                 -- buyer shipping/contact snapshot (shipping only)
  tracking_carrier         TEXT,
  tracking_number          TEXT,
  -- Stripe provenance (mirrors payments columns; enables idempotent webhook + refund/tax reversal)
  stripe_payment_intent_id  TEXT,
  stripe_charge_id          TEXT,
  stripe_tax_calculation_id TEXT,
  stripe_tax_transaction_id TEXT,
  stripe_tax_reversal_id    TEXT,
  -- Lifecycle: payment state and fulfillment state are intentionally SEPARATE.
  payment_status           TEXT NOT NULL DEFAULT 'pending'
                             CHECK (payment_status IN ('pending','processing','paid','failed','refunded')),
  fulfillment_status       TEXT NOT NULL DEFAULT 'unfulfilled'
                             CHECK (fulfillment_status IN ('unfulfilled','ready_for_pickup','picked_up','shipped','completed','cancelled')),
  -- Payout eligibility is a FLAG only — it never moves money. Advantage.Bid retains manual settlement.
  payout_eligible          BOOLEAN NOT NULL DEFAULT false,
  payout_eligible_at       TIMESTAMPTZ,
  refunded_amount_cents    INTEGER NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0),
  refund_status            TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','refunded')),
  is_demo                  BOOLEAN NOT NULL DEFAULT false,
  idempotency_key          TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                  TIMESTAMPTZ,
  refunded_at              TIMESTAMPTZ
);

-- One live order per one-of-one item: at most one order in a non-terminal money state (pending/processing/
-- paid) per item. A failed/refunded order is EXCLUDED, so the item can be relisted and re-purchased. This
-- is the DB-level backstop against double-selling, complementing the item status transition claim.
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_orders_live_item
  ON marketplace_orders (marketplace_item_id)
  WHERE payment_status IN ('pending','processing','paid');
-- Webhook idempotency: one order per PaymentIntent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_orders_intent
  ON marketplace_orders (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_buyer  ON marketplace_orders (buyer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_seller ON marketplace_orders (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_payout ON marketplace_orders (payout_eligible) WHERE payout_eligible = true;
