-- Migration: 040_add_auction_lat_lng.sql
-- Adds geographic coordinates to auctions for radius-based discovery.
-- Both columns are nullable — existing rows are unaffected; values populated
-- manually or via a future geocoding step (not auto-derived from city/zip).

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

-- Partial index: only rows with actual coordinates benefit from spatial lookup
CREATE INDEX IF NOT EXISTS idx_auctions_lat_lng
  ON auctions(lat, lng) WHERE lat IS NOT NULL AND lng IS NOT NULL;
