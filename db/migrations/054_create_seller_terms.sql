-- Migration: 054_create_seller_terms.sql
-- Seller Agreement System — Phase A. Per-seller financial/contractual terms.
-- HISTORY-PRESERVING (owner decision): edits append a new row and stamp
-- superseded_at on the prior row, so "what terms applied when" is reportable.
-- Exactly one current row per seller (superseded_at IS NULL).

CREATE TABLE IF NOT EXISTS seller_terms (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_profile_id    UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  commission_pct       NUMERIC(5,2),
  buyer_premium_pct    NUMERIC(5,2),
  credit_card_fee_pct  NUMERIC(5,2),
  marketing_fee_cents  INTEGER,
  settlement_terms     TEXT,
  payout_schedule      TEXT,
  effective_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at        TIMESTAMPTZ,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one current (non-superseded) terms row per seller.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_seller_terms_current
  ON seller_terms(seller_profile_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_seller_terms_seller ON seller_terms(seller_profile_id);
