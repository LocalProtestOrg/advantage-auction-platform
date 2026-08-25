-- 114_event_image_provenance.sql
--
-- Provenance for enriched external event images. ADDITIVE ONLY, idempotent. Lets us record where a
-- stored auction image came from (source URL/host, retrieval time) when the image-enrichment service
-- fetches a legitimately-public, permitted image and re-hosts it into managed storage. No behavior
-- change on its own; existing rows keep NULL provenance.

ALTER TABLE event_images
  ADD COLUMN IF NOT EXISTS source_url    TEXT,        -- the public page/asset the image came from
  ADD COLUMN IF NOT EXISTS source_host   TEXT,        -- hostname (for at-a-glance provenance/audit)
  ADD COLUMN IF NOT EXISTS retrieved_at  TIMESTAMPTZ; -- when it was fetched/re-hosted
