-- 100_event_import_fields.sql — additive + idempotent. Event Import Framework: canonical event fields.
-- ADD COLUMN IF NOT EXISTS only — no column is dropped or retyped; every existing serializer is an
-- explicit allowlist, so these columns are invisible until code reads them. Verified pre-write: none of
-- these names collide with the current events/event_images columns, and event_images has zero duplicate
-- (event_id, position) rows so the unique index is safe. `category_slug` stays primary (categories[] is
-- secondary); `events.source` is NOT widened ('imported' already exists — WHICH source is event_sources' job).

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS subtitle               text,
  ADD COLUMN IF NOT EXISTS sale_type              text CHECK (sale_type IN ('estate_sale','auction','other')),
  ADD COLUMN IF NOT EXISTS event_format           text CHECK (event_format IN ('online','live','hybrid')),
  ADD COLUMN IF NOT EXISTS organizer_name         text,
  ADD COLUMN IF NOT EXISTS organizer_logo_url     text,
  ADD COLUMN IF NOT EXISTS organizer_website_url  text,
  ADD COLUMN IF NOT EXISTS contact_name           text,
  ADD COLUMN IF NOT EXISTS contact_phone          text,
  ADD COLUMN IF NOT EXISTS contact_email          text,
  ADD COLUMN IF NOT EXISTS registration_url       text,
  ADD COLUMN IF NOT EXISTS bidding_url            text,
  ADD COLUMN IF NOT EXISTS sale_hours             jsonb,
  ADD COLUMN IF NOT EXISTS preview_start          timestamptz,
  ADD COLUMN IF NOT EXISTS preview_end            timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_start           timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_end             timestamptz,
  ADD COLUMN IF NOT EXISTS closing_schedule       jsonb,
  ADD COLUMN IF NOT EXISTS shipping_available     boolean,
  ADD COLUMN IF NOT EXISTS local_pickup_available boolean,
  ADD COLUMN IF NOT EXISTS buyer_premium_bps      integer,          -- basis points, matches auctions.buyer_premium_bps (067)
  ADD COLUMN IF NOT EXISTS payment_methods        text[],
  ADD COLUMN IF NOT EXISTS terms_text             text,
  ADD COLUMN IF NOT EXISTS tags                   text[],
  ADD COLUMN IF NOT EXISTS categories             text[],           -- secondary categories; category_slug stays primary
  ADD COLUMN IF NOT EXISTS source_last_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS content_hash           text,
  ADD COLUMN IF NOT EXISTS market_resolved_via    text,
  ADD COLUMN IF NOT EXISTS geocoding_status       text,             -- mirrors auctions geocoding (090) so shouldGeocode() works
  ADD COLUMN IF NOT EXISTS geocoding_source       text,
  ADD COLUMN IF NOT EXISTS location_fingerprint   text,
  ADD COLUMN IF NOT EXISTS geocoded_at            timestamptz;

ALTER TABLE event_images
  ADD COLUMN IF NOT EXISTS source_url    text,
  ADD COLUMN IF NOT EXISTS content_hash  text,
  ADD COLUMN IF NOT EXISTS public_id     text,
  ADD COLUMN IF NOT EXISTS width         integer,
  ADD COLUMN IF NOT EXISTS height        integer,
  ADD COLUMN IF NOT EXISTS alt_text      text;

-- Image content-hash dedup (per event) — only over real hashes; NULLs (legacy rows) stay unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_images_content  ON event_images(event_id, content_hash) WHERE content_hash IS NOT NULL;
-- Stable slot ordering per event (verified: zero existing duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_images_position ON event_images(event_id, position);

COMMIT;
