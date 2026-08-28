-- 118: Google Places API (New) prospect discovery — dedup key + research observability.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Does NOT touch any Sales-activity column; the import path keeps
-- the research/activity separation established in migration 116 (refresh never overwrites a rep's work).

-- Strong dedup key for Google-discovered businesses (a Place ID is stable + unique per business).
ALTER TABLE sales_prospects ADD COLUMN IF NOT EXISTS google_place_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_prospects_place_id
  ON sales_prospects (google_place_id) WHERE google_place_id IS NOT NULL;

-- Observability: one row per research run (Google request counts, yields, states, errors) so the Owner
-- can compare request counts against Google Cloud billing. NEVER stores the API key.
CREATE TABLE IF NOT EXISTS prospect_research_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source            TEXT NOT NULL DEFAULT 'google_places',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','stopped')),
  queries_made      INTEGER NOT NULL DEFAULT 0,
  api_requests      INTEGER NOT NULL DEFAULT 0,
  results_received  INTEGER NOT NULL DEFAULT 0,
  inserted          INTEGER NOT NULL DEFAULT 0,
  enriched          INTEGER NOT NULL DEFAULT 0,
  duplicates        INTEGER NOT NULL DEFAULT 0,
  skipped_irrelevant INTEGER NOT NULL DEFAULT 0,
  skipped_no_contact INTEGER NOT NULL DEFAULT 0,
  actionable_new    INTEGER NOT NULL DEFAULT 0,
  api_errors        INTEGER NOT NULL DEFAULT 0,
  states            JSONB,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_prospect_research_runs_started ON prospect_research_runs (started_at DESC);

-- Checkpoint / resume + refresh-age: which (source, query) cells have already been searched, and when,
-- so an interrupted run resumes without re-billing completed queries and a refresh honors an age threshold.
CREATE TABLE IF NOT EXISTS prospect_research_queries (
  query_key      TEXT PRIMARY KEY,          -- e.g. 'google_places|estate sale company|MI|Detroit'
  source         TEXT NOT NULL DEFAULT 'google_places',
  query_text     TEXT,
  state          TEXT,
  last_run_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  results_count  INTEGER NOT NULL DEFAULT 0,
  new_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prospect_research_queries_lastrun ON prospect_research_queries (last_run_at);
