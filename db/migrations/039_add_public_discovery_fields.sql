-- Migration: 039_add_public_discovery_fields.sql
-- Adds seller public profile display fields and auction marketplace ordering field
-- for the /api/public/* discovery layer.
-- All new columns are nullable or have safe defaults; existing rows are unaffected.

-- seller_profiles: public-facing display fields surfaced on BD/marketplace widgets
ALTER TABLE seller_profiles
  ADD COLUMN IF NOT EXISTS display_name   TEXT,
  ADD COLUMN IF NOT EXISTS bio            TEXT,
  ADD COLUMN IF NOT EXISTS location_label TEXT,
  ADD COLUMN IF NOT EXISTS logo_url       TEXT;

-- auctions: integer priority for marketplace feature ordering (higher = more prominent)
-- Defaults to 0 so all existing auctions are unaffected and sort by start_time.
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS marketplace_priority INTEGER NOT NULL DEFAULT 0;

-- Indexes for discovery queries
CREATE INDEX IF NOT EXISTS idx_auctions_mp_priority
  ON auctions(marketplace_priority DESC, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_auctions_shipping_on
  ON auctions(shipping_available) WHERE shipping_available = true;

CREATE INDEX IF NOT EXISTS idx_auctions_state_mp
  ON auctions(state, marketplace_priority DESC);
