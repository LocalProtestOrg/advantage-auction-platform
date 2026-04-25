-- Migration: 021_create_notification_tables.sql
-- Notification preferences and async delivery queue.
-- No external API calls happen here — a separate worker drains the queue.

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id        UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled  BOOLEAN     NOT NULL DEFAULT TRUE,
  sms_enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  phone_number   TEXT,
  sms_consent    BOOLEAN     NOT NULL DEFAULT FALSE,
  sms_consent_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications_queue (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT        NOT NULL CHECK (type IN ('OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON')),
  payload    JSONB       NOT NULL DEFAULT '{}'::JSONB,
  status     TEXT        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'sent', 'failed')),
  attempts   INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker queries pending rows ordered by creation time.
CREATE INDEX IF NOT EXISTS idx_notifications_queue_pending
  ON notifications_queue(status, created_at)
  WHERE status = 'pending';

-- Per-user history lookup.
CREATE INDEX IF NOT EXISTS idx_notifications_queue_user
  ON notifications_queue(user_id, created_at DESC);
