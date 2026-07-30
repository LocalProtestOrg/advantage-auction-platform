-- 098_import_runs.sql — additive + idempotent. Event Import Framework: run ledger + per-record trail.
-- Two new tables only; touches no existing table's schema. `import_runs` is the dashboard/run history and
-- carries the weekly scheduler run-claim (a partial UNIQUE index). `import_run_items` is the per-record
-- dead-letter trail so one bad record never aborts a run (§9, §10, §11 of the plan).

BEGIN;

CREATE TABLE IF NOT EXISTS import_runs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           uuid        NOT NULL REFERENCES import_sources(id),
  trigger             text        NOT NULL CHECK (trigger IN ('scheduled','manual','backfill')),
  scheduled_for       date,
  status              text        NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','partial','failed')),
  fetched             integer     NOT NULL DEFAULT 0,
  eligible            integer     NOT NULL DEFAULT 0,
  created             integer     NOT NULL DEFAULT 0,
  updated             integer     NOT NULL DEFAULT 0,
  skipped_duplicate   integer     NOT NULL DEFAULT 0,
  skipped_quality     integer     NOT NULL DEFAULT 0,
  skipped_ambiguous   integer     NOT NULL DEFAULT 0,
  images_queued       integer     NOT NULL DEFAULT 0,
  failed              integer     NOT NULL DEFAULT 0,
  capped              boolean     NOT NULL DEFAULT false,
  remaining_available integer,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  duration_ms         integer,
  last_error          text,
  stats               jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Weekly run claim: at most one SCHEDULED run per source per scheduled_for. A second replica's INSERT
-- conflicts → true mutual exclusion. Manual/backfill runs are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_runs_scheduled_claim
  ON import_runs(source_id, scheduled_for) WHERE trigger = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_import_runs_source ON import_runs(source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS import_run_items (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid        NOT NULL REFERENCES import_runs(id),
  source_event_id text,
  event_id        uuid        REFERENCES events(id),
  outcome         text        NOT NULL CHECK (outcome IN ('created','updated','unchanged','duplicate','ambiguous','rejected_quality','failed')),
  match_via       text,
  market_via      text,
  reason          text,
  error           text,
  raw_excerpt     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_run_items_run     ON import_run_items(run_id);
CREATE INDEX IF NOT EXISTS idx_import_run_items_outcome ON import_run_items(outcome);

COMMIT;
