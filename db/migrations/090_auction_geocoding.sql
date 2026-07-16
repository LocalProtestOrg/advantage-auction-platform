-- Migration: 090_auction_geocoding.sql
-- Automatic auction geocoding for the homepage discovery map.
--
-- Supersedes the note in 040_add_auction_lat_lng.sql ("populated manually or via a
-- future geocoding step") — this IS that step.
--
-- COORDINATE MODEL (two tiers, deliberately):
--   lat / lng                  PUBLIC DISPLAY coordinates. Already exposed by
--                              /api/public/auctions and already read by the homepage
--                              map, so reusing them means no public API or frontend
--                              change. These are an OFFSET point, never the property.
--   internal_lat / internal_lng  PRIVATE precise coordinates from the provider.
--                              Never exposed publicly. Public endpoints use explicit
--                              column lists, so these do not leak by addition; the only
--                              SELECT * on auctions is admin-only (admin.js), and admins
--                              are entitled to the precise location.
--
-- Why the split: the platform already publishes city, state, zip and STREET NAME
-- (auctions.js strips the house number into pickup_street). Publishing rooftop
-- coordinates would effectively restore the house number and reverse-geocode back to
-- the property. Public coordinates are therefore a deterministic ~0.10mi offset.
--
-- All columns are nullable / defaulted — existing rows are unaffected, and the nine
-- Knoxville auctions that already carry valid coordinates are not touched.

ALTER TABLE auctions
  -- Private precise coordinates (approved workflow: "Store Internal Coordinates").
  -- Retained so public coordinates can be recomputed later (e.g. if intersection
  -- snapping is added post-launch) without re-billing a geocoding request.
  ADD COLUMN IF NOT EXISTS internal_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS internal_lng DOUBLE PRECISION,

  -- Admin-visible status + error (approved: "Record a visible geocoding status or
  -- error", "Allow an Admin to retry"). Status is advisory only and never gates
  -- saving or publishing an auction.
  --   ok | failed | unconfigured | manual | insufficient_location
  ADD COLUMN IF NOT EXISTS geocoding_status TEXT,
  ADD COLUMN IF NOT EXISTS geocoding_error  TEXT,

  -- Provenance. geocoding_source names the provider ('mapbox') or 'manual', which is
  -- what makes the provider genuinely replaceable: a later provider swap can identify
  -- and re-geocode only the rows it previously owned, without disturbing manual work.
  ADD COLUMN IF NOT EXISTS geocoding_source TEXT,
  ADD COLUMN IF NOT EXISTS geocoded_at      TIMESTAMPTZ,

  -- Approved: "Manual overrides are never overwritten automatically." Every automatic
  -- write checks this flag; only an explicit admin re-geocode clears it.
  ADD COLUMN IF NOT EXISTS coordinates_manually_overridden BOOLEAN NOT NULL DEFAULT false,

  -- Approved: "Do not repeat the request when the location has not changed and valid
  -- coordinates already exist." Hash of the normalized location string; a request is
  -- skipped when the fingerprint matches and public coordinates are present. This is
  -- the mechanism for that rule, not convenience metadata.
  ADD COLUMN IF NOT EXISTS location_fingerprint TEXT;

-- Backfill/repair lookup: find auctions still missing public display coordinates.
-- Partial index — only the rows the backfill and the publish-recovery path scan.
CREATE INDEX IF NOT EXISTS idx_auctions_missing_public_coords
  ON auctions (id) WHERE lat IS NULL OR lng IS NULL;
