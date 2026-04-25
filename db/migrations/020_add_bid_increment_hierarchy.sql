-- Migration: 020_add_bid_increment_hierarchy.sql
-- Adds flat bid_increment_cents to lots and auctions, and creates the
-- auction_houses table that supplies the house-wide default.

-- Lot-level override (highest precedence).
ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS bid_increment_cents INTEGER;

-- Auction-level override (middle precedence).
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS bid_increment_cents INTEGER;

-- Auction house: supplies the lowest-precedence default.
CREATE TABLE IF NOT EXISTS auction_houses (
  id                          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT,
  default_bid_increment_cents INTEGER DEFAULT 500,
  created_at                  TIMESTAMP DEFAULT NOW()
);

-- Link auctions to their house so the hierarchy can be walked.
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS auction_house_id UUID REFERENCES auction_houses(id);
