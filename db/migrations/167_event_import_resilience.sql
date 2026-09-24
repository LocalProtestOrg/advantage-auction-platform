-- 167_event_import_resilience.sql — ADDITIVE + idempotent.
--
-- Event importer resilience (2026-09-24 audit). Findings this migration supports:
--   • A source that REFUSED automated access (Lewis & Maese: 403) and a source that simply had nothing
--     upcoming both ended as "completed, fetched 0". Runs now carry an explicit zero-result reason, and
--     each source keeps a persisted health state, failure / zero-run streaks and a bounded retry slot.
--   • Transient failures are retried automatically (1h / 2h / 4h, at most 3) under the new 'retry' run
--     trigger; structural failures (blocked, unreadable) are never retried automatically.
--   • The three EstateSales.NET CSV sources are one-time manual pastes from July/August: 177 events, none
--     current, 0 created since Aug 2 — they re-read the same frozen rows every run. Paused (not deleted;
--     their events and provenance are untouched) and marked NO_LONGER_USEFUL.
--   • A txauction.com practice listing ("TEST AUCTION FOR BIDDERS … There are no actual items for sale",
--     2022 → 2031) was published as a real event. The validator now rejects test listings and implausible
--     durations; the existing row is set to 'rejected' (never deleted) with the reason recorded.
--
-- No event is deleted, no source is deleted, and no Lewis & Maese commercial / pricing data is touched.

BEGIN;

-- ── 1. Per-source health state ───────────────────────────────────────────────────────────────
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS health_state text;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS health_reason text;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS health_updated_at timestamptz;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS consecutive_zero_runs integer NOT NULL DEFAULT 0;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS last_success_at timestamptz;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS last_nonzero_at timestamptz;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS last_failure_at timestamptz;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
ALTER TABLE import_sources ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_import_sources_health_state') THEN
    ALTER TABLE import_sources ADD CONSTRAINT chk_import_sources_health_state CHECK (health_state IS NULL OR health_state IN
      ('HEALTHY','DEGRADED','BROKEN','BLOCKED_BY_SOURCE','NO_LONGER_USEFUL','NEEDS_REVIEW'));
  END IF;
END $$;

-- Seed last-success / last-nonzero from the existing run history (read-only derivation).
UPDATE import_sources s SET
  last_success_at = COALESCE(s.last_success_at, (SELECT max(r.finished_at) FROM import_runs r WHERE r.source_id = s.id AND r.status = 'completed')),
  last_nonzero_at = COALESCE(s.last_nonzero_at, (SELECT max(r.finished_at) FROM import_runs r WHERE r.source_id = s.id AND r.status = 'completed' AND r.fetched > 0));

-- ── 2. The 'retry' run trigger ───────────────────────────────────────────────────────────────
ALTER TABLE import_runs DROP CONSTRAINT IF EXISTS import_runs_trigger_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_trigger_check
  CHECK (trigger IN ('scheduled','manual','backfill','retry'));

-- ── 3. Frozen manual CSV sources → paused, NO_LONGER_USEFUL (only if nothing of theirs is current) ──
UPDATE import_sources s
   SET status = 'paused',
       config = s.config || jsonb_build_object('frozen_reason',
         'one-time manual CSV paste from July/August 2026; every row is past and it can never produce a new current event',
         'paused_reason', 'frozen manual input — paused by the 2026-09-24 importer audit (events kept)'),
       health_state = 'NO_LONGER_USEFUL',
       health_reason = 'one-time manual CSV paste; every row is past',
       health_updated_at = now(),
       updated_at = now()
 WHERE s.kind = 'csv' AND s.status = 'active'
   AND s.key IN ('estatesales-houston', 'estatesales-national', 'estatesales-us')
   AND NOT EXISTS (SELECT 1 FROM event_sources es JOIN events e ON e.id = es.event_id
                    WHERE es.source_id = s.id AND e.end_at >= now());

-- ── 4. The published practice listing → rejected (kept, reason recorded) ─────────────────────
UPDATE events
   SET status = 'rejected',
       review_reason = 'not_a_real_event:test_listing — the host marks it a practice auction with no items for sale (2022→2031 placeholder dates); removed by the 2026-09-24 importer audit',
       updated_at = now()
 WHERE id = '93b9beef-ba8f-4556-bade-f3712bd226f3' AND source = 'imported' AND status = 'published';

COMMIT;
