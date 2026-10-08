-- 190_sms_consent_versions_suppression.sql
-- Text-alert consent records that match exactly what the customer saw, a number-level do-not-text list, and an
-- inbound keyword log for STOP / START / HELP syncing. Nothing is switched on: every auction_sms.* and sasha.phone.*
-- switch keeps its value, no consent, text or suppression row is created, and no existing row is rewritten.
--
--   sms_consents / sms_consent_events  + consent_version, terms_last_updated, privacy_last_updated, surface
--                                        (historical rows keep NULL: they were recorded under the original wording)
--   sms_suppressions                    one row per phone number that replied STOP (or that the provider reports as
--                                        unsubscribed). While 'suppressed', NO text of any kind is sent to it: alerts,
--                                        Phone Sasha texts, payment links. START releases it; it never re-enables alerts.
--   sms_inbound_events                  one row per inbound provider message id (idempotency). Stores the matched
--                                        keyword, a hash and the last 4 digits of the sender, never the message body.
--
-- Rollback: DROP TABLE sms_inbound_events, sms_suppressions;
--   ALTER TABLE sms_consents DROP COLUMN consent_version, DROP COLUMN terms_last_updated, DROP COLUMN privacy_last_updated, DROP COLUMN surface;
--   ALTER TABLE sms_consent_events DROP COLUMN consent_version, DROP COLUMN terms_last_updated, DROP COLUMN privacy_last_updated, DROP COLUMN surface;

BEGIN;

ALTER TABLE sms_consents       ADD COLUMN IF NOT EXISTS consent_version      text;
ALTER TABLE sms_consents       ADD COLUMN IF NOT EXISTS terms_last_updated   text;
ALTER TABLE sms_consents       ADD COLUMN IF NOT EXISTS privacy_last_updated text;
ALTER TABLE sms_consents       ADD COLUMN IF NOT EXISTS surface              text;
ALTER TABLE sms_consent_events ADD COLUMN IF NOT EXISTS consent_version      text;
ALTER TABLE sms_consent_events ADD COLUMN IF NOT EXISTS terms_last_updated   text;
ALTER TABLE sms_consent_events ADD COLUMN IF NOT EXISTS privacy_last_updated text;
ALTER TABLE sms_consent_events ADD COLUMN IF NOT EXISTS surface              text;

CREATE TABLE IF NOT EXISTS sms_suppressions (
  phone_hash     text PRIMARY KEY,                -- identifierHash(e164); the full number is not stored here
  phone_last4    text,
  status         text NOT NULL CHECK (status IN ('suppressed', 'released')),
  reason         text NOT NULL CHECK (reason IN ('stop_keyword', 'provider_unsubscribed', 'admin')),
  keyword        text,
  suppressed_at  timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  release_reason text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_inbound_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_message_id text NOT NULL UNIQUE,
  from_hash         text,
  from_last4        text,
  keyword           text,                         -- the matched keyword only (STOP, START, HELP, ...), or NULL
  action            text NOT NULL CHECK (action IN ('stop', 'start', 'help', 'other')),
  accounts_affected integer NOT NULL DEFAULT 0,
  alerts_turned_off integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_inbound_events_created ON sms_inbound_events (created_at DESC);

COMMIT;
