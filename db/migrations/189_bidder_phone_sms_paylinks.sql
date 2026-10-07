-- 189: Verified bidder phones, opt-in auction SMS, Phone Sasha email verification + payment links (2026-10-07).
-- ADDITIVE / IDEMPOTENT / REVERSIBLE. Every new behavior ships OFF.
--
-- Verified phone (account security; NOT consent to texts):
--   users.phone_verified_e164   the exact E.164 number that was verified. "Verified" means phone_verified_at IS NOT NULL
--                               AND this equals the normalized users.phone, so changing the number (any path) un-verifies.
--   users.phone_changed_at      set when a verified number replaces a different verified number (Phone Sasha will not use
--                               a just-changed number to verify a caller for 24 hours).
--   account_phone_verifications 4-digit codes for verifying the account's phone on the website (hash only, attempts, expiry).
-- Phone Sasha:
--   cs_phone_verifications.channel 'sms' | 'email'; provider 'email_code'; 4-digit codes (hash only).
--   payment_links               single-use, 30-minute pay links (token HASH only), bound to user + combined invoice.
--   cs_phone_audit event types  payment-link lifecycle and email delivery.
-- Optional auction SMS (separate, affirmative opt-in per type):
--   sms_consents / sms_consent_events   current state + full history (who, type, when, source, opt-out time).
--   auction_sms_messages                every outbid / watched-closing text decision (sent or suppressed, with reason).
-- Switches (all OFF): bidder_phone.required, bidder_phone.verification_enabled, auction_sms.enabled,
--   auction_sms.a2p_confirmed, auction_sms.offer_opt_in. Cooldown 5 min, reminder 60 min before closing start.
--
-- Rollback: DROP TABLE auction_sms_messages, sms_consent_events, sms_consents, payment_links, account_phone_verifications;
--   ALTER TABLE users DROP COLUMN phone_verified_e164, DROP COLUMN phone_changed_at; ALTER TABLE cs_phone_verifications DROP COLUMN channel;
--   restore the cs_phone_verifications provider CHECK and the cs_phone_audit event CHECK from migration 188;
--   DELETE FROM platform_config WHERE category IN ('bidder_phone','auction_sms').

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_e164 text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_changed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_users_phone_verified ON users (phone_verified_e164) WHERE phone_verified_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_phone_verifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_e164      text NOT NULL,
  phone_hash      text NOT NULL,
  provider        text NOT NULL CHECK (provider IN ('twilio_verify', 'local_test')),
  provider_ref    text,
  code_hash       text,                     -- local_test only; never the code
  status          text NOT NULL CHECK (status IN ('sent', 'approved', 'failed', 'expired', 'superseded', 'send_failed')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  ip_hash         text,
  expires_at      timestamptz NOT NULL,
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_apv_user ON account_phone_verifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_apv_phone ON account_phone_verifications (phone_hash, created_at DESC);

ALTER TABLE cs_phone_verifications ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email'));
ALTER TABLE cs_phone_verifications DROP CONSTRAINT IF EXISTS cs_phone_verifications_provider_check;
ALTER TABLE cs_phone_verifications ADD CONSTRAINT cs_phone_verifications_provider_check CHECK (provider IN ('local_test', 'twilio_verify', 'email_code', 'none'));
ALTER TABLE cs_phone_verifications ADD COLUMN IF NOT EXISTS caller_number_hash text;
ALTER TABLE cs_phone_verifications ALTER COLUMN max_attempts SET DEFAULT 3;

ALTER TABLE cs_phone_audit DROP CONSTRAINT IF EXISTS cs_phone_audit_event_type_check;
ALTER TABLE cs_phone_audit ADD CONSTRAINT cs_phone_audit_event_type_check CHECK (event_type IN ('call_started', 'call_ended', 'verification_started',
  'verification_succeeded', 'verification_failed', 'verification_locked', 'session_started', 'session_ended', 'tool_disclosed', 'tool_nothing_to_disclose',
  'tool_refused', 'text_sent', 'text_refused', 'email_sent', 'card_data_redacted', 'handoff_requested', 'callback_requested', 'staff_alerted', 'budget_stopped',
  'payment_link_requested', 'payment_link_refused', 'payment_link_sent', 'payment_link_opened', 'payment_link_rejected', 'payment_link_consumed'));

CREATE TABLE IF NOT EXISTS payment_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash            text NOT NULL UNIQUE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  combined_invoice_id   uuid NOT NULL,
  invoice_number        text,
  amount_cents_at_issue integer,
  call_id               uuid REFERENCES cs_calls(id) ON DELETE SET NULL,
  phone_session_id      uuid REFERENCES cs_phone_sessions(id) ON DELETE SET NULL,
  delivery              text NOT NULL CHECK (delivery IN ('sms', 'email')),
  destination_last4     text,
  is_simulated          boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'consumed', 'expired', 'superseded')),
  expires_at            timestamptz NOT NULL,
  opened_at             timestamptz,
  used_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_links_invoice ON payment_links (combined_invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_links_user ON payment_links (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sms_consents (
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sms_type             text NOT NULL CHECK (sms_type IN ('outbid', 'watched_closing')),
  status               text NOT NULL CHECK (status IN ('opted_in', 'opted_out')),
  opted_in_at          timestamptz,
  opted_out_at         timestamptz,
  source               text NOT NULL,          -- auction_registration | notification_settings | sms_keyword | admin
  source_context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_text         text,
  phone_e164_at_opt_in text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sms_type)
);

CREATE TABLE IF NOT EXISTS sms_consent_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sms_type        text NOT NULL,
  action          text NOT NULL CHECK (action IN ('opt_in', 'opt_out')),
  source          text NOT NULL,
  source_context  jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_text    text,
  phone_last4     text,
  ip_hash         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_consent_events_user ON sms_consent_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auction_sms_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('outbid', 'watched_closing')),
  auction_id        uuid,
  lot_id            uuid,
  closing_start_at  timestamptz,
  status            text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'suppressed', 'failed')),
  suppress_reason   text,
  dedupe_key        text NOT NULL UNIQUE,
  body              text,
  phone_last4       text,
  provider_ref      text,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_asm_pending ON auction_sms_messages (status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_asm_cooldown ON auction_sms_messages (user_id, lot_id, kind, sent_at DESC) WHERE status = 'sent';
-- One watched-auction closing reminder per bidder + auction, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_asm_watched_sent ON auction_sms_messages (user_id, auction_id) WHERE kind = 'watched_closing' AND status = 'sent';

INSERT INTO platform_config (key, value, category, description) VALUES
  ('bidder_phone.required', 'false'::jsonb, 'bidder_phone', 'Require a verified mobile number to register for an auction (and to bid in registrations made after it was turned on).'),
  ('bidder_phone.verification_enabled', 'false'::jsonb, 'bidder_phone', 'Allow customers to verify their phone on the website (needs a working code sender).'),
  ('auction_sms.enabled', 'false'::jsonb, 'auction_sms', 'Send optional outbid / watched-auction texts to opted-in bidders.'),
  ('auction_sms.a2p_confirmed', 'false'::jsonb, 'auction_sms', 'Owner confirmation that the A2P 10DLC campaign covers these texts.'),
  ('auction_sms.offer_opt_in', 'false'::jsonb, 'auction_sms', 'Show the optional text-alert checkboxes to bidders.'),
  ('auction_sms.outbid_cooldown_minutes', '5'::jsonb, 'auction_sms', 'At most one outbid text per bidder per lot in this many minutes.'),
  ('auction_sms.watched_reminder_minutes', '60'::jsonb, 'auction_sms', 'Watched-auction reminder this many minutes before lots begin closing.')
ON CONFLICT (key) DO NOTHING;

-- Phone Sasha: shorter-lived, fewer-attempt codes now that they are 4 digits.
UPDATE platform_config SET value = '5'::jsonb WHERE key = 'sasha.phone.code_ttl_minutes' AND value = '10'::jsonb;
UPDATE platform_config SET value = '3'::jsonb WHERE key = 'sasha.phone.code_max_attempts' AND value = '5'::jsonb;

COMMIT;
