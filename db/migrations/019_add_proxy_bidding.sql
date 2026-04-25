-- Migration: 019_add_proxy_bidding.sql
-- Adds proxy (max) bid table, marks proxy bid rows, and tracks live winner on lot.

-- One active proxy max per bidder per lot; UNIQUE enforces the upsert pattern.
CREATE TABLE IF NOT EXISTS lot_proxy_bids (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id           UUID        NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  bidder_user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_amount_cents INTEGER     NOT NULL CHECK (max_amount_cents > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lot_id, bidder_user_id)
);

-- Efficient ranking query: highest max first, earliest created_at wins ties.
CREATE INDEX IF NOT EXISTS idx_lot_proxy_bids_rank
  ON lot_proxy_bids(lot_id, max_amount_cents DESC, created_at ASC);

-- Flag proxy-generated bid history rows so the UI can distinguish them.
ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS is_proxy BOOLEAN DEFAULT FALSE;

-- Track the current leading bidder on the lot (updated by proxy resolution).
ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS current_winner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
