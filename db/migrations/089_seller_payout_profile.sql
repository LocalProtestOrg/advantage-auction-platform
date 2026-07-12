-- Migration: 089_seller_payout_profile.sql
-- Increment 5 (Seller Payout Profile). ADDITIVE ONLY.
--
-- Extends seller_payout_preferences (migration 016) with Stripe-managed ACH display
-- fields and a lightweight future tax placeholder. It NEVER stores a routing number,
-- account number, or full account identifier — only a Stripe-managed reference plus
-- safe display data (last4 already exists as ach_account_last4).
ALTER TABLE seller_payout_preferences
  ADD COLUMN IF NOT EXISTS bank_name               TEXT,        -- display only (from Stripe)
  ADD COLUMN IF NOT EXISTS ach_account_type        TEXT,        -- 'checking' | 'savings' (display)
  ADD COLUMN IF NOT EXISTS stripe_bank_account_ref TEXT,        -- Stripe-managed bank account id/token ref (NOT a routing/account number)
  ADD COLUMN IF NOT EXISTS setup_completed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tax_status              TEXT NOT NULL DEFAULT 'not_started'; -- future placeholder only

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payout_pref_tax_status') THEN
    ALTER TABLE seller_payout_preferences
      ADD CONSTRAINT chk_payout_pref_tax_status
      CHECK (tax_status IN ('not_started', 'in_progress', 'completed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payout_pref_ach_account_type') THEN
    ALTER TABLE seller_payout_preferences
      ADD CONSTRAINT chk_payout_pref_ach_account_type
      CHECK (ach_account_type IS NULL OR ach_account_type IN ('checking', 'savings'));
  END IF;
END $$;
