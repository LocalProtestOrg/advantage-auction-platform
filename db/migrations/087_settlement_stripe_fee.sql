-- Migration: 087_settlement_stripe_fee.sql
-- Increment 3 support. ADDITIVE ONLY.
--
-- Adds actual-Stripe-processing-cost capture to payments so the seller settlement
-- reimburses the REAL Stripe expense (Decision 1) instead of a flat percentage.
-- stripe_fee_cents is populated best-effort from the Stripe balance transaction when
-- a settlement is computed (read-time backfill in settlementEngine) — the live
-- payment/webhook path is intentionally NOT modified. Inert until settlements enable.
--
-- No column is dropped or retyped.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS stripe_fee_cents       INTEGER,      -- actual Stripe processing cost (cents); NULL = not yet captured
  ADD COLUMN IF NOT EXISTS stripe_fee_captured_at TIMESTAMPTZ,  -- when the fee was read from the balance transaction
  ADD COLUMN IF NOT EXISTS stripe_balance_txn_id  TEXT;         -- source balance_transaction id (provenance)
