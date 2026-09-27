-- 172_ses_inbound_email.sql
-- Shared inbound email on Amazon SES (replaces the Postmark parsed-inbound provider, which is unavailable).
--
-- Mail to reply.advantage.bid is received by an SES receipt rule, stored whole in S3, and announced by a
-- signed SNS notification. One row per received message is the durable record of that notification:
--   * duplicate protection: an SES message id is processed once, however often SNS retries;
--   * safe holding: while every inbound switch is OFF, a message is recorded as held and processed later,
--     never lost (the email itself stays in S3);
--   * failure recovery: a failed fetch or parse is retried with backoff, then left for a person;
--   * audit: which programme it reached, how it was classified and what was done, without storing the body
--     here (the body lives in the programme's own message table, or only in S3 when unmatched).
-- Additive only. Changes no existing table, no switch and no row.

CREATE TABLE IF NOT EXISTS inbound_email_receipts (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ses_message_id     text        NOT NULL,
  sns_message_id     text,
  topic_arn          text,
  bucket             text        NOT NULL,
  object_key         text        NOT NULL,
  recipients         text[]      NOT NULL DEFAULT '{}',
  mail_from          text,                                   -- envelope sender, normalized
  verdicts           jsonb       NOT NULL DEFAULT '{}'::jsonb, -- spam / virus / spf / dkim / dmarc
  raw_sha256         text,                                   -- digest of the stored message, once fetched
  programme          text        CHECK (programme IN ('claimed_listing', 'event_partner', 'unmatched')),
  status             text        NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received', 'held_disabled', 'processing', 'processed', 'duplicate',
                                       'quarantined', 'ignored', 'failed', 'needs_review')),
  outcome            jsonb       NOT NULL DEFAULT '{}'::jsonb, -- classification, action, company, message ids
  attempts           integer     NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz,
  last_error         text,
  notified_at        timestamptz,                            -- oversight email sent (at most once)
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_email_receipts_ses_message ON inbound_email_receipts (ses_message_id);
CREATE INDEX IF NOT EXISTS idx_inbound_email_receipts_retry
  ON inbound_email_receipts (next_attempt_at) WHERE status IN ('held_disabled', 'failed', 'received');
CREATE INDEX IF NOT EXISTS idx_inbound_email_receipts_status ON inbound_email_receipts (status, received_at DESC);
