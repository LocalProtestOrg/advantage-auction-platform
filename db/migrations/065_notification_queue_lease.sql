-- Migration: 065_notification_queue_lease.sql
-- Email reliability (stabilization sprint): give the notifications_queue the
-- columns the hardened worker needs — a lease (status='processing' + locked_at),
-- retry backoff (next_attempt_at), a 'skipped' terminal state for stale/dropped
-- notifications, and diagnostics (last_error, processed_at). All additive.

-- Expand the status domain: + 'processing' (claimed/leased) and 'skipped'
-- (intentionally not sent — e.g. a stale outbid for a lot that already closed).
ALTER TABLE notifications_queue DROP CONSTRAINT IF EXISTS notifications_queue_status_check;
ALTER TABLE notifications_queue
  ADD CONSTRAINT notifications_queue_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped'));

ALTER TABLE notifications_queue ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE notifications_queue ADD COLUMN IF NOT EXISTS locked_at       TIMESTAMPTZ;
ALTER TABLE notifications_queue ADD COLUMN IF NOT EXISTS last_error      TEXT;
ALTER TABLE notifications_queue ADD COLUMN IF NOT EXISTS processed_at    TIMESTAMPTZ;

-- Dequeue index: ready-to-send pending rows, oldest first, honoring backoff.
CREATE INDEX IF NOT EXISTS idx_notifications_queue_ready
  ON notifications_queue (next_attempt_at, created_at)
  WHERE status = 'pending';

-- Reaper index: find leases to release after a crash.
CREATE INDEX IF NOT EXISTS idx_notifications_queue_processing
  ON notifications_queue (locked_at)
  WHERE status = 'processing';
