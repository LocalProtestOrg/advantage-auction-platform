-- Migration: 002_add_max_bids.sql
-- Adds max_bids table for proxy bidding foundation

-- max_bids: stores each bidder's current max bid per lot
-- Used for proxy bidding calculation without exposing max to public
CREATE TABLE IF NOT EXISTS max_bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  bidder_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_amount_cents INTEGER NOT NULL CHECK (max_amount_cents > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lot_id, bidder_user_id)
);

-- Index for efficient ranking by lot and amount (used in tie-break queries)
CREATE INDEX IF NOT EXISTS idx_max_bids_lot_amount_created ON max_bids(lot_id, max_amount_cents DESC, created_at ASC);

-- Trigger to auto-update updated_at
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_max_bids_updated_at') THEN
    CREATE TRIGGER trg_max_bids_updated_at
    BEFORE UPDATE ON max_bids
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
