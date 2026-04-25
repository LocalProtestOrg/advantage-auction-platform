-- Migration: 015_create_seller_payouts.sql
-- Tracks seller payout records created after auction close.
-- Money movement (ACH, check) is handled separately; this table is status tracking only.

CREATE TABLE IF NOT EXISTS seller_payouts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id           UUID        NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  seller_user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  gross_revenue_cents  INTEGER     NOT NULL DEFAULT 0,
  platform_fee_cents   INTEGER     NOT NULL DEFAULT 0,
  seller_payout_cents  INTEGER     NOT NULL DEFAULT 0,
  payout_method        TEXT,
  payout_status        TEXT        NOT NULL DEFAULT 'pending',
  payout_reference     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (auction_id)
);

CREATE INDEX IF NOT EXISTS idx_seller_payouts_auction_id      ON seller_payouts(auction_id);
CREATE INDEX IF NOT EXISTS idx_seller_payouts_seller_user_id  ON seller_payouts(seller_user_id);
CREATE INDEX IF NOT EXISTS idx_seller_payouts_payout_status   ON seller_payouts(payout_status);
