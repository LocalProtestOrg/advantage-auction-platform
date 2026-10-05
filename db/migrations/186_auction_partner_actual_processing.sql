-- 186: Auction Partner actual Stripe processing pass-through (2026-10-05). ADDITIVE / IDEMPOTENT / REVERSIBLE.
--
-- Owner policy: an Auction Partner auction published under the 0% Advantage.Bid platform fee deducts the ACTUAL Stripe
-- processing fee of its buyers' payments (no markup, no subsidy), instead of the 3%-of-hammer policy rate.
--
-- 1. auctions.processing_fee_basis: frozen at publish together with the rest of the pricing snapshot.
--      NULL / 'policy_rate' = existing rules (v2: frozen processing_fee_bps of hammer; legacy: unchanged)
--      'actual_stripe'      = actual Stripe fee of the auction's collected buyer payments
--    Every existing auction stays NULL, so no historical settlement changes.
-- 2. payments.stripe_refund_fee_*: the fee effect recorded on a payment's refund balance transactions (Stripe may or
--    may not return processing fees on a refund; we record what Stripe actually did) and the refunded total it was
--    captured for, so a later refund invalidates it.
--
-- Rollback: ALTER TABLE auctions DROP COLUMN processing_fee_basis;
--           ALTER TABLE payments DROP COLUMN stripe_refund_fee_cents, DROP COLUMN stripe_refund_fee_refunded_cents,
--                                DROP COLUMN stripe_refund_fee_captured_at;

BEGIN;

ALTER TABLE auctions ADD COLUMN IF NOT EXISTS processing_fee_basis text;
ALTER TABLE auctions DROP CONSTRAINT IF EXISTS chk_auctions_processing_fee_basis;
ALTER TABLE auctions ADD CONSTRAINT chk_auctions_processing_fee_basis
  CHECK (processing_fee_basis IS NULL OR processing_fee_basis IN ('policy_rate', 'actual_stripe'));

ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_refund_fee_cents integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_refund_fee_refunded_cents integer;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_refund_fee_captured_at timestamptz;

COMMIT;
