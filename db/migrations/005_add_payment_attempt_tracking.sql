-- Migration: 005_add_payment_attempt_tracking.sql
-- Adds retry attempt timestamp for cooldown logic support

ALTER TABLE IF EXISTS payments
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;

-- Index for efficient querying of failed payments by attempt time (for cooldown logic)
CREATE INDEX IF NOT EXISTS idx_payments_last_attempted ON payments(last_attempted_at);
