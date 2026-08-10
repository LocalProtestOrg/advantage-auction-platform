-- Migration: 108_seller_connect_payouts.sql
-- Version 1.0 Stripe Connect (manual-control Direct Deposit). ADDITIVE ONLY — no data
-- rewrite, no drops. Adds safe Connect-account fields to the seller payout profile and the
-- Stripe transfer lifecycle to seller_payouts. Stores only safe identifiers + display;
-- Stripe retains all raw bank credentials.
--
-- Direct Deposit reuses payout_method='ach' (existing CHECK IN ('ach','check')) and
-- payment_method_used='ach' on seller_payouts (existing CHECK) — no constraint change.

-- 1. Connect account (Direct Deposit destination) — safe fields only.
ALTER TABLE seller_payout_preferences
  ADD COLUMN IF NOT EXISTS stripe_account_id          TEXT,       -- Stripe Connected Account id (acct_…); NOT bank data
  ADD COLUMN IF NOT EXISTS connect_status             TEXT,       -- not_started | onboarding | ready | restricted
  ADD COLUMN IF NOT EXISTS connect_details_submitted  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_transfers_active   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_payouts_enabled    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_disabled_reason    TEXT,       -- Stripe requirements.disabled_reason (safe status string)
  ADD COLUMN IF NOT EXISTS connect_bank_name          TEXT,       -- safe display only (from external_account)
  ADD COLUMN IF NOT EXISTS connect_bank_last4         TEXT,       -- safe display only (last 4)
  ADD COLUMN IF NOT EXISTS connect_updated_at         TIMESTAMPTZ;

-- One Connected Account per seller (backstop; nullable rows allowed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_payout_prefs_stripe_account
  ON seller_payout_preferences (stripe_account_id) WHERE stripe_account_id IS NOT NULL;

-- 2. Stripe transfer lifecycle on the settlement row (Direct Deposit release).
ALTER TABLE seller_payouts
  ADD COLUMN IF NOT EXISTS stripe_transfer_id         TEXT,       -- Stripe Transfer id (tr_…) created at Admin approval
  ADD COLUMN IF NOT EXISTS transfer_initiated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transfer_failure_message   TEXT;

-- Idempotency backstop: at most one transfer id per settlement (blocks duplicate transfers).
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_payouts_stripe_transfer
  ON seller_payouts (stripe_transfer_id) WHERE stripe_transfer_id IS NOT NULL;
