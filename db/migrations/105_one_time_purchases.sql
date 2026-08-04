-- 105_one_time_purchases.sql — additive + idempotent.
--
-- Phase 2B: Individual Estate Sale Promotion ($39 one-time, homeowners). A one-time, single-use,
-- consumable purchase — NOT a subscription (professional_memberships) and NOT a capability (boolean
-- org grant). Generic by `product_type` so future one-time products (featured listing, listing bump)
-- reuse the same table. Customer-facing name is always "Estate Sale Promotion"; this table is internal.
--
-- Lifecycle: pending → paid (verified Stripe webhook) → consumed (when the estate sale is submitted
-- for review; event_id links the sale). An "available" promotion = status='paid' AND event_id IS NULL.
-- Refund → refunded. No users.role change; no change to the existing free events/capability system.

CREATE TABLE IF NOT EXISTS one_time_purchases (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID NOT NULL REFERENCES users(id),
  organization_id            UUID REFERENCES organizations(id),
  product_type               TEXT NOT NULL DEFAULT 'estate_sale_promotion',
  status                     TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','consumed','refunded')),
  stripe_customer_id         TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id   TEXT,
  amount_cents               INTEGER,
  currency                   TEXT DEFAULT 'usd',
  event_id                   UUID REFERENCES events(id),   -- the estate sale this promotion is spent on
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at                    TIMESTAMPTZ,
  consumed_at                TIMESTAMPTZ,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One purchase per Stripe Checkout Session (idempotent webhook upserts).
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_time_purchases_session
  ON one_time_purchases (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_one_time_purchases_user  ON one_time_purchases (user_id, product_type, status);
CREATE INDEX IF NOT EXISTS idx_one_time_purchases_event ON one_time_purchases (event_id);

-- Nationwide market so a homeowner anywhere can create an estate sale (events.market_slug is NOT NULL;
-- only houston + nyc_tristate were seeded before this).
INSERT INTO event_markets (slug, name, sort_order) VALUES ('national', 'Nationwide', 100)
ON CONFLICT (slug) DO NOTHING;
