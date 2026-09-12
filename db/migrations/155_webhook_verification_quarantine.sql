-- 155_webhook_verification_quarantine.sql — ADDITIVE + idempotent. Fail-safe handling for a provider
-- callback whose authenticity could not be established because verification infrastructure was
-- temporarily unavailable.
--
-- The problem this closes. Migration 154 verified SNS signatures properly, but chose to INGEST a
-- callback whose signing certificate could not be fetched, reasoning that losing bounce and complaint
-- data is itself a compliance harm. That reasoning is right about the data and wrong about the timing:
-- it let an UNVERIFIED callback apply suppression, complaint, bounce, deliverability and consent
-- changes — recipient-affecting, effectively irreversible state — on the strength of a network error.
--
-- The corrected rule:
--   valid signature      -> process normally
--   invalid signature    -> reject, and never process
--   cannot verify (yet)  -> PERSIST here, apply NOTHING, retry verification, process exactly once
--                           when authenticity is finally established
--   never verifiable     -> keep forever as evidence, never process
--
-- Nothing is ever silently discarded. The evidence is the whole payload, so a quarantined callback can
-- be replayed byte-for-byte once it is trusted.

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_callback_quarantine (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text        NOT NULL,              -- 'ses_sns' | 'postmark' | ...
  -- The complete callback, kept so it can be reprocessed exactly as it arrived once verified.
  payload            jsonb       NOT NULL,
  -- Idempotency and replay protection in one: the same bytes can only ever occupy one row, so a
  -- provider retrying while we are still unable to verify does not create a second pending item and
  -- cannot cause a second application of state.
  payload_sha256     text        NOT NULL,
  provider_message_id text,                              -- SNS MessageId, where present
  topic_arn          text,
  event_kind         text,
  status             text        NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification','verified_processed','rejected_invalid','abandoned')),
  -- Why it landed here, and what the most recent verification attempt concluded.
  signature_status   text        NOT NULL,
  last_reason        text,
  verify_attempts    integer     NOT NULL DEFAULT 0,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_attempt_at    timestamptz,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  -- Set once, when the callback is finally processed. Its presence IS the exactly-once guard.
  processed_at       timestamptz,
  process_result     jsonb,
  remote_ip_hash     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_quarantine_payload
  ON webhook_callback_quarantine (provider, payload_sha256);
-- The retry worker's claim index: only pending rows that are due.
CREATE INDEX IF NOT EXISTS idx_webhook_quarantine_due
  ON webhook_callback_quarantine (next_attempt_at)
  WHERE status = 'pending_verification';
CREATE INDEX IF NOT EXISTS idx_webhook_quarantine_status
  ON webhook_callback_quarantine (status, first_seen_at DESC);

-- A processed row must say when, and a row that has not been processed must not claim a result.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_webhook_quarantine_processed') THEN
    ALTER TABLE webhook_callback_quarantine
      ADD CONSTRAINT chk_webhook_quarantine_processed
      CHECK ((status = 'verified_processed') = (processed_at IS NOT NULL));
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Owner-tunable retry policy.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform_config (key, value, category) VALUES
  -- How many times to re-attempt verification before a callback is marked 'abandoned'. Abandoned
  -- means "still never applied" — the row and its payload are kept forever as evidence.
  ('webhooks.quarantine_max_attempts',   '12',    'security'),
  -- Base backoff in seconds; the service applies exponential growth with a ceiling.
  ('webhooks.quarantine_backoff_seconds', '300',  'security'),
  -- Master switch for the retry worker. ON: a quarantined callback is re-verified and, once
  -- authentic, processed exactly once. OFF: callbacks still quarantine (nothing is lost) but no
  -- automatic reprocessing happens.
  ('webhooks.quarantine_retry_enabled',  'true',  'security')
ON CONFLICT (key) DO NOTHING;

COMMIT;
