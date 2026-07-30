-- 099_event_sources.sql — additive + idempotent. Event Import Framework: provenance.
-- One row per (import source, external id). This is the idempotency + change-detection backbone:
-- re-importing the same external record updates the linked event instead of duplicating it, and the
-- content/images hashes let unchanged records short-circuit with zero writes. New table only; touches
-- no existing table's schema. The same event arriving from two sources = two rows (different source_id).

BEGIN;

CREATE TABLE IF NOT EXISTS event_sources (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid        NOT NULL REFERENCES events(id),
  source_id         uuid        NOT NULL REFERENCES import_sources(id),
  source_event_id   text        NOT NULL,          -- the source's stable id (the idempotency key)
  source_url        text,                           -- attribution target (original host)
  source_url_hash   text,                           -- normalized-URL hash (utm/fragment stripped)
  source_updated_at timestamptz,
  content_hash      text,                           -- change detection over the canonical record
  images_hash       text,                           -- separate image re-sync trigger
  first_imported_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at    timestamptz NOT NULL DEFAULT now(),
  sync_status       text        NOT NULL DEFAULT 'active' CHECK (sync_status IN ('active','removed')),
  raw_payload       jsonb
);

-- Idempotent upsert target: at most one row per (source, external id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_sources_source_event ON event_sources(source_id, source_event_id);
-- Secondary idempotency on normalized source URL, when present.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_sources_source_url  ON event_sources(source_id, source_url_hash) WHERE source_url_hash IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_event_sources_content    ON event_sources(content_hash);
CREATE INDEX        IF NOT EXISTS idx_event_sources_event      ON event_sources(event_id);

COMMIT;
