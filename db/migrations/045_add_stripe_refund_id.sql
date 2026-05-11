-- Migration: 045_add_stripe_refund_id.sql
-- Adds stripe_refund_id column to payments so refund confirmations can be
-- linked back to the Stripe Refund object. Nullable because test-seeded
-- payments and manual admin overrides may not have a Stripe intent.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_refund_id ON payments(stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;
