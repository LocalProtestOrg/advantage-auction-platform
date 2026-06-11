-- Migration: 058_extend_stripe_webhook_events.sql
-- (Renumbered from 046 during Line B reconciliation onto e0f005f; 046/047 were
--  already taken by production-applied migrations. Content unchanged.)
-- Phase 1 Sub-batch 1 — Settlement Integrity Hardening
--
-- Extends stripe_webhook_events to support:
--   * claim-after-process semantics (status column distinguishes claimed-but-unfinished
--     from claimed-and-finished)
--   * retryable failure tracking (status='failed' + last_error + attempt_count)
--   * raw payload archival for replay/audit (payload column)
--   * received_at separate from processed_at so processing latency is measurable
--
-- DEPLOYMENT ORDER:
--   This migration MUST run BEFORE the Sub-batch 1 application code is deployed.
--   The old code reads and writes only (id, event_type, processed_at). After this
--   migration runs, old code continues to work — new columns get default values
--   from this migration. The legacy backfill below ensures pre-migration rows
--   are correctly marked 'processed' so the new claim-after-process logic does
--   not interpret them as in-flight when re-delivered or replayed.
--
-- ROLLBACK:
--   This migration is additive. To revert: DROP COLUMN for each ADDed column and
--   DROP INDEX. No data loss for the original (id, event_type, processed_at) surface.

ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processed','failed')),
  ADD COLUMN IF NOT EXISTS payload JSONB,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill: pre-migration rows were inserted only on successful processing by the
-- old code, so they are by definition 'processed'. Mark them so the new logic
-- does not treat them as in-flight on any re-delivery or replay.
UPDATE stripe_webhook_events
   SET status = 'processed'
 WHERE status = 'received';

-- Index for reconciliation queries: "show failed events in the last hour",
-- "show oldest stuck 'received' events", etc.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status_received
  ON stripe_webhook_events(status, received_at);
