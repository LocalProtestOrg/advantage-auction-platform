-- Migration: 003_add_winning_bidder_tracking.sql
-- Adds fields to track winning bidder and final amount per lot

ALTER TABLE IF EXISTS lots
  ADD COLUMN IF NOT EXISTS winning_buyer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS winning_amount_cents INTEGER,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Index for efficient lookup of winning lots by buyer
CREATE INDEX IF NOT EXISTS idx_lots_winning_buyer ON lots(winning_buyer_user_id);

-- Index for efficient lookup of resolved lots
CREATE INDEX IF NOT EXISTS idx_lots_resolved_at ON lots(resolved_at);
