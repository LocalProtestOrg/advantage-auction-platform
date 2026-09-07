-- 138_owner_alert_log.sql — durable idempotency + audit trail for OWNER OPERATIONAL SMS alerts.
-- ADDITIVE + idempotent + production-safe. Does NOT alter any pricing/settlement/marketing/customer-SMS
-- behavior. One row per logical owner-action event (dedup_key UNIQUE) guarantees the invariant:
--   ONE LOGICAL OWNER-ACTION EVENT -> AT MOST ONE SUCCESSFUL OWNER SMS
-- across request/worker/webhook retries, restarts, and deploys. A 'failed' row may be retried; a 'sent'
-- row is never re-sent. NO secrets, NO Twilio credentials, and NO recipient phone number are stored here —
-- only the recipient CLASS ('owner'), the provider message SID/status, and the business entity reference.

CREATE TABLE IF NOT EXISTS owner_alert_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type       TEXT NOT NULL,                 -- e.g. auction_submitted | estate_sale_submitted | marketing_package_purchased | owner_alert_test
  entity_type      TEXT NOT NULL,                 -- e.g. auction | event | one_time_purchase | owner_alert
  entity_id        TEXT NOT NULL,                 -- business record id (UUID as text; test uses a synthetic id)
  dedup_key        TEXT NOT NULL,                 -- alert_type + ':' + entity_id — the idempotency guarantee
  recipient_class  TEXT NOT NULL DEFAULT 'owner', -- NEVER the phone number itself
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sent','failed','skipped')),
  provider_sid     TEXT,                          -- Twilio message SID (not a secret)
  provider_status  TEXT,                          -- Twilio message status (queued/accepted/sent/...)
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  first_attempt_at TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The idempotency key: at most one row per (alert_type, entity_id). ON CONFLICT drives dedup.
CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_alert_log_dedup ON owner_alert_log(dedup_key);
CREATE INDEX IF NOT EXISTS idx_owner_alert_log_type ON owner_alert_log(alert_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_alert_log_status ON owner_alert_log(status);
