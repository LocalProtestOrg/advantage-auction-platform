-- Migration: 086_settlement_foundation.sql
-- Increment 2 of the approved manual seller-settlement workflow. ADDITIVE ONLY.
--
-- Adds:
--   1. settlement_adjustments  — manual credit/debit adjustments (Decision 4).
--   2. settlement_snapshots    — versioned snapshots (Settlement Versioning) with an
--                                immutable final row frozen at approval/payment
--                                (Settlement Snapshot).
--   3. seller_payouts.*         — additive settlement-status + payment-status columns
--                                (the approved 5-state workflow from settlementPolicy).
--
-- No existing table or column is dropped or retyped. Everything here is INERT until
-- SELLER_SETTLEMENTS_ENABLED is turned on in a later increment. Legacy seller_payouts
-- columns (payout_status, payout_reference, payout_method) are left intact; the new
-- settlement_status is authoritative for the settlement workflow going forward.

-- 1. Manual settlement adjustments. amount_cents is always POSITIVE; adjustment_type
--    ('credit' | 'debit') sets the sign applied to seller proceeds. Removal is a soft
--    VOID (voided_at) so the audit trail is preserved (never a hard delete).
CREATE TABLE IF NOT EXISTS settlement_adjustments (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id         UUID        NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  seller_user_id     UUID        NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  adjustment_type    TEXT        NOT NULL CHECK (adjustment_type IN ('credit', 'debit')),
  amount_cents       INTEGER     NOT NULL CHECK (amount_cents > 0),
  reason             TEXT        NOT NULL,
  notes              TEXT,
  created_by_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  voided_at          TIMESTAMPTZ,
  voided_by_user_id  UUID        REFERENCES users(id) ON DELETE SET NULL,
  void_reason        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settlement_adjustments_auction
  ON settlement_adjustments(auction_id) WHERE voided_at IS NULL;

-- 2. Versioned settlement snapshots. One row per computed version (version increments
--    on each recalculation before payment). The row with is_final = true is the
--    IMMUTABLE historical record frozen at approval/payment and must never be mutated
--    (enforced in application logic; at most one final row per auction below).
CREATE TABLE IF NOT EXISTS settlement_snapshots (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id         UUID        NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  seller_user_id     UUID        NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  version            INTEGER     NOT NULL CHECK (version >= 1),
  snapshot           JSONB       NOT NULL,
  is_final           BOOLEAN     NOT NULL DEFAULT false,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (auction_id, version)
);
CREATE INDEX IF NOT EXISTS idx_settlement_snapshots_auction
  ON settlement_snapshots(auction_id, version DESC);
-- At most one frozen/final snapshot per auction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlement_snapshot_final
  ON settlement_snapshots(auction_id) WHERE is_final;

-- 3. Settlement workflow + payment-status fields on seller_payouts (all additive).
ALTER TABLE seller_payouts
  ADD COLUMN IF NOT EXISTS settlement_status       TEXT        NOT NULL DEFAULT 'pending_review',
  ADD COLUMN IF NOT EXISTS settlement_version      INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS approved_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by_user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS on_hold_reason          TEXT,
  ADD COLUMN IF NOT EXISTS paid_at                 TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by_user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_method_used     TEXT,
  ADD COLUMN IF NOT EXISTS final_amount_paid_cents INTEGER;

-- Guard settlement_status to the approved 5-state workflow (idempotent add).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_seller_payouts_settlement_status') THEN
    ALTER TABLE seller_payouts
      ADD CONSTRAINT chk_seller_payouts_settlement_status
      CHECK (settlement_status IN ('pending_review','approved','ready_for_payment','paid','on_hold'));
  END IF;
END $$;

-- Guard payment_method_used to ach/check when present (idempotent add).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_seller_payouts_payment_method_used') THEN
    ALTER TABLE seller_payouts
      ADD CONSTRAINT chk_seller_payouts_payment_method_used
      CHECK (payment_method_used IS NULL OR payment_method_used IN ('ach','check'));
  END IF;
END $$;
