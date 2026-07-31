-- 102_event_internal_coordinates.sql — additive + idempotent.
--
-- Two-tier event coordinates, matching the auctions model (migration 090):
--   internal_lat / internal_lng  PRIVATE precise point from the geocoder. NEVER exposed publicly
--                                (public serializers use explicit column lists and do not select it).
--   lat / lng                    PUBLIC display marker — a deterministic ~0.10mi privacy OFFSET of the
--                                precise point (services/geocoding/publicCoordinates.js), never the
--                                rooftop. Already the columns the public feed/map read, so no public
--                                API or frontend change is needed.
--
-- Why: before this, imported-event geocoding wrote the geocoder's EXACT coordinates straight into the
-- public lat/lng (no offset, no internal tier) — a latent exact-location leak the moment a token was
-- present. This adds the missing private tier so events can store exact coords internally while the
-- public marker is the offset. All columns nullable/defaulted — existing rows are unaffected.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS internal_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS internal_lng DOUBLE PRECISION;

-- Backfill/repair lookup: events still missing a public marker (mirrors idx_auctions_missing_public_coords).
CREATE INDEX IF NOT EXISTS idx_events_missing_public_coords
  ON events (id) WHERE lat IS NULL OR lng IS NULL;
