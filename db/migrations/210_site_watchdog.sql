-- 210_site_watchdog.sql — sitewide automated watchdog (owner assignment 2026-10-30). ADDITIVE + idempotent.
-- Three new tables; no existing table or row is changed.
--   watchdog_runs         one row per run (server checks in the worker, or browser results posted from the scheduled job)
--   watchdog_findings     de-duplicated problems: one row per stable dedupe key; open → resolved when the check passes
--                         again; re-opened when it fails again. Alerts are sent only for new or re-opened findings.
--   watchdog_check_state  per-check schedule and last outcome (drives "due" scheduling by risk tier)
-- Rollback (safe at any time; nothing else references these tables):
--   DROP TABLE IF EXISTS watchdog_check_state; DROP TABLE IF EXISTS watchdog_findings; DROP TABLE IF EXISTS watchdog_runs;

CREATE TABLE IF NOT EXISTS watchdog_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT NOT NULL CHECK (source IN ('server', 'browser', 'manual')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  checks_run     INTEGER NOT NULL DEFAULT 0,
  checks_failed  INTEGER NOT NULL DEFAULT 0,
  checks_skipped INTEGER NOT NULL DEFAULT 0,
  opened         INTEGER NOT NULL DEFAULT 0,
  resolved       INTEGER NOT NULL DEFAULT 0,
  summary        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_watchdog_runs_started ON watchdog_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS watchdog_findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key      TEXT NOT NULL UNIQUE,
  check_id        TEXT NOT NULL,
  feature         TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'normal', 'warning')),
  code            TEXT NOT NULL,
  detail          TEXT NOT NULL,
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  reproduce       TEXT,
  source          TEXT NOT NULL DEFAULT 'server',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  occurrences     INTEGER NOT NULL DEFAULT 1,
  reopened_count  INTEGER NOT NULL DEFAULT 0,
  needs_alert     BOOLEAN NOT NULL DEFAULT false,
  alerted_at      TIMESTAMPTZ,
  last_run_id     UUID REFERENCES watchdog_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_watchdog_findings_open ON watchdog_findings (status, severity) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_watchdog_findings_check ON watchdog_findings (check_id, status);

CREATE TABLE IF NOT EXISTS watchdog_check_state (
  check_id             TEXT PRIMARY KEY,
  last_run_at          TIMESTAMPTZ,
  last_status          TEXT,
  last_duration_ms     INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
