-- 101_market_resolution.sql — additive + idempotent. Event Import Framework: market resolution.
-- Curated markets, resilient resolution, admin-gated growth (§6 of the plan). Imports never fail on
-- geography: anything that doesn't resolve lands in the permanent 'national' market and is queued for
-- an admin to promote into a real metro. Touches only the events-market curation surface.

BEGIN;

-- 1) Permanent fallback market. Inactive → hidden from the public market picker, but 'national' events
--    still appear in unfiltered feeds/search/maps/sitemap. sort_order last.
INSERT INTO event_markets (slug, name, is_active, sort_order)
VALUES ('national', 'Nationwide', false, 9999)
ON CONFLICT (slug) DO NOTHING;

-- 2) Backfill center/radius for the two live markets so radius matching works (was NULL → radius no-op).
--    WHERE center_lat IS NULL keeps this non-destructive on re-run and if an admin later tunes them.
UPDATE event_markets SET center_lat = 29.7604, center_lng = -95.3698, radius_km = 120
 WHERE slug = 'houston'      AND center_lat IS NULL;
UPDATE event_markets SET center_lat = 40.7128, center_lng = -74.0060, radius_km = 140
 WHERE slug = 'nyc_tristate' AND center_lat IS NULL;

-- 3) Curated resolution rules: a row maps EITHER a ZIP prefix OR a (city, state) to a market.
--    The radius pass uses event_markets center/radius; this table adds explicit ZIP/city overrides.
CREATE TABLE IF NOT EXISTS event_market_zips (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  market_slug text        NOT NULL REFERENCES event_markets(slug),
  zip_prefix  text,
  city        text,
  state       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (zip_prefix IS NOT NULL OR (city IS NOT NULL AND state IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_market_zips_prefix ON event_market_zips(zip_prefix)                 WHERE zip_prefix IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_market_zips_city   ON event_market_zips(lower(city), upper(state))  WHERE city IS NOT NULL;

-- 4) Metro discovery queue: every 'national' fallback bumps a counter keyed on normalized city|state,
--    so the admin dashboard can surface "Phoenix, AZ — 14 events in national" and one-click create a market.
CREATE TABLE IF NOT EXISTS market_candidates (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_key        text        NOT NULL UNIQUE,          -- normalized 'city|state'
  city                 text,
  state                text,
  event_count          integer     NOT NULL DEFAULT 0,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  resolved_market_slug text        REFERENCES event_markets(slug),   -- set once an admin promotes it
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_candidates_count ON market_candidates(event_count DESC);

COMMIT;
