-- 228_owner_review_digest.sql
-- Daily owner review digest (owner 2026-11-10): one summary of every task waiting for a human, at 9:00 AM
-- America/New_York, by email to owner.notify_emails and by text to the platform owner's verified phone.
-- Additive only: two new tables. Changes no existing row, table or notification.
--
--   owner_digest_runs        one row per America/New_York calendar day (the primary key makes a second run impossible,
--                            across instances and restarts). A short lease lets exactly one process work the day at a
--                            time; the composed message is stored so a retry sends the same content.
--   owner_digest_deliveries  one row per (day, channel, recipient): attempts, last error, sent time. A recipient is
--                            identified by a one-way hash and a masked hint (last 4), never the full address or number.
--
-- Rollback: DROP TABLE owner_digest_deliveries; DROP TABLE owner_digest_runs;

BEGIN;

CREATE TABLE IF NOT EXISTS owner_digest_runs (
  run_date        date        PRIMARY KEY,                        -- America/New_York calendar day
  status          text        NOT NULL DEFAULT 'composing'
                    CHECK (status IN ('composing', 'sending', 'complete', 'partial', 'failed', 'nothing_pending')),
  lease_until     timestamptz,                                    -- the process working the day holds this
  task_count      integer     NOT NULL DEFAULT 0,
  summary         jsonb       NOT NULL DEFAULT '{}'::jsonb,       -- counts per category; no customer data
  destinations    jsonb       NOT NULL DEFAULT '{}'::jsonb,       -- configured / verified / not used (masked)
  email_subject   text,
  email_text      text,
  email_html      text,
  sms_text        text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS owner_digest_deliveries (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date        date        NOT NULL REFERENCES owner_digest_runs (run_date) ON DELETE CASCADE,
  channel         text        NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient_hash  text        NOT NULL,
  recipient_hint  text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text,
  last_attempt_at timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_date, channel, recipient_hash)
);

COMMIT;
