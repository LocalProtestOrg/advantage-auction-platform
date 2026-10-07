-- 188: Phone Sasha foundation (2026-10-07). ADDITIVE / IDEMPOTENT / REVERSIBLE. The phone channel stays OFF.
--
-- Provider-independent pieces for answering calls with the existing Sasha engine (Twilio ConversationRelay planned):
--   cs_conversations.channel  + 'phone'
--   cs_calls                  one row per call (provider + provider call id, caller number HASH and last 4 only,
--                             status, verification state, summary, transcript retention). No audio is ever stored.
--   cs_phone_verifications    one row per verification attempt (identifier HASH, target account, provider, attempts,
--                             sends, expiry, outcome). Codes are never stored in plain text: the local test provider
--                             keeps only a salted hash; Twilio Verify keeps the code on Twilio's side.
--   cs_phone_sessions         short-lived verified phone-support session bound to ONE call and ONE account.
--   cs_phone_audit            who was verified, which account was accessed, which sensitive tool ran, what was
--                             disclosed or refused, which call caused it. Never codes, card data or addresses.
--   cs_handoffs.callback_*    callback queue on the existing handoff table.
--   users.phone_verified_at   set when a caller proves possession of the phone on file. users.phone is NOT changed.
--
-- Switches (platform_config, category 'sasha_phone'): sasha.phone.enabled = false. No route accepts provider traffic
-- in this release, so production cannot receive a call even if the switch were turned on.
--
-- Rollback: DROP TABLE cs_phone_audit, cs_phone_sessions, cs_phone_verifications, cs_calls;
--           ALTER TABLE cs_handoffs DROP COLUMN callback_requested, DROP COLUMN callback_phone_e164,
--             DROP COLUMN callback_status, DROP COLUMN callback_note; ALTER TABLE users DROP COLUMN phone_verified_at;
--           restore the cs_conversations channel CHECK to ('email','chat') once no 'phone' rows exist;
--           DELETE FROM platform_config WHERE category = 'sasha_phone'.

BEGIN;

ALTER TABLE cs_conversations DROP CONSTRAINT IF EXISTS cs_conversations_channel_check;
ALTER TABLE cs_conversations ADD CONSTRAINT cs_conversations_channel_check CHECK (channel IN ('email', 'chat', 'phone'));

CREATE TABLE IF NOT EXISTS cs_calls (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES cs_conversations(id) ON DELETE CASCADE,
  provider             text NOT NULL CHECK (provider IN ('simulated', 'twilio_cr', 'retell')),
  provider_call_id     text NOT NULL,
  is_simulated         boolean NOT NULL DEFAULT false,
  simulated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  caller_number_hash   text,                 -- sha256(salt + E.164); caller ID is a hint, never identity
  caller_number_last4  text,
  called_number        text,                 -- our number (E.164), not personal data
  status               text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('queued', 'in_progress', 'completed', 'failed')),
  verification_state   text NOT NULL DEFAULT 'anonymous' CHECK (verification_state IN ('anonymous', 'code_sent', 'verified', 'locked', 'expired')),
  verified_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  card_data_redacted   integer NOT NULL DEFAULT 0,
  interruptions        integer NOT NULL DEFAULT 0,
  summary              text,                 -- non-sensitive call summary (kept after the transcript is purged)
  end_reason           text,
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  duration_seconds     integer,
  transcript_purge_after timestamptz,        -- set at call end from sasha.phone.transcript_retention_days
  transcript_purged_at timestamptz,
  UNIQUE (provider, provider_call_id)
);
CREATE INDEX IF NOT EXISTS idx_cs_calls_conversation ON cs_calls (conversation_id);
CREATE INDEX IF NOT EXISTS idx_cs_calls_active ON cs_calls (status) WHERE status IN ('queued', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_cs_calls_purge ON cs_calls (transcript_purge_after) WHERE transcript_purged_at IS NULL;

CREATE TABLE IF NOT EXISTS cs_phone_verifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id              uuid NOT NULL REFERENCES cs_calls(id) ON DELETE CASCADE,
  target_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL when nothing matched (never revealed to the caller)
  identifier_type      text NOT NULL CHECK (identifier_type IN ('email', 'phone')),
  identifier_hash      text NOT NULL,
  provider             text NOT NULL CHECK (provider IN ('local_test', 'twilio_verify', 'none')),
  provider_ref         text,
  code_hash            text,                 -- local_test provider only: salted hash, never the code
  destination_last4    text,
  status               text NOT NULL CHECK (status IN ('sent', 'approved', 'failed', 'expired', 'no_match', 'no_phone', 'ambiguous', 'locked', 'send_failed', 'superseded')),
  attempts             integer NOT NULL DEFAULT 0,
  max_attempts         integer NOT NULL DEFAULT 5,
  expires_at           timestamptz NOT NULL,
  verified_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cs_pv_call ON cs_phone_verifications (call_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cs_pv_user ON cs_phone_verifications (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cs_pv_ident ON cs_phone_verifications (identifier_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS cs_phone_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id              uuid NOT NULL REFERENCES cs_calls(id) ON DELETE CASCADE,
  conversation_id      uuid NOT NULL REFERENCES cs_conversations(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verification_id      uuid NOT NULL REFERENCES cs_phone_verifications(id) ON DELETE CASCADE,
  level                text NOT NULL DEFAULT 'sms_code' CHECK (level IN ('sms_code')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  ended_at             timestamptz,
  end_reason           text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_phone_session_live ON cs_phone_sessions (call_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS cs_phone_audit (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id              uuid REFERENCES cs_calls(id) ON DELETE SET NULL,
  conversation_id      uuid REFERENCES cs_conversations(id) ON DELETE SET NULL,
  phone_session_id     uuid REFERENCES cs_phone_sessions(id) ON DELETE SET NULL,
  account_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  is_simulated         boolean NOT NULL DEFAULT false,
  actor_user_id        uuid REFERENCES users(id) ON DELETE SET NULL,   -- the Super Admin running a simulation
  event_type           text NOT NULL CHECK (event_type IN ('call_started', 'call_ended', 'verification_started', 'verification_succeeded',
                         'verification_failed', 'verification_locked', 'session_started', 'session_ended', 'tool_disclosed', 'tool_nothing_to_disclose',
                         'tool_refused', 'text_sent', 'text_refused', 'card_data_redacted', 'handoff_requested', 'callback_requested', 'staff_alerted',
                         'budget_stopped')),
  tool                 text,
  data_category        text,                 -- account, bids, invoices, pickup_address, pickup_slot, orders, seller_status, ...
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb,   -- references only (invoice numbers, auction ids, counts)
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cs_phone_audit_call ON cs_phone_audit (call_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cs_phone_audit_account ON cs_phone_audit (account_user_id, created_at DESC);

ALTER TABLE cs_handoffs ADD COLUMN IF NOT EXISTS callback_requested boolean NOT NULL DEFAULT false;
ALTER TABLE cs_handoffs ADD COLUMN IF NOT EXISTS callback_phone_e164 text;
ALTER TABLE cs_handoffs ADD COLUMN IF NOT EXISTS callback_status text CHECK (callback_status IS NULL OR callback_status IN ('open', 'in_progress', 'done', 'cancelled'));
ALTER TABLE cs_handoffs ADD COLUMN IF NOT EXISTS callback_note text;
CREATE INDEX IF NOT EXISTS idx_cs_handoffs_callbacks ON cs_handoffs (callback_status) WHERE callback_requested;

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

INSERT INTO platform_config (key, value, category, description) VALUES
  ('sasha.phone.enabled', 'false'::jsonb, 'sasha_phone', 'Phone Sasha on a real telephone provider. OFF: no provider traffic is accepted.'),
  ('sasha.phone.provider', '"none"'::jsonb, 'sasha_phone', 'Voice provider adapter for real calls: none | twilio_cr | retell.'),
  ('sasha.phone.verify_provider', '"none"'::jsonb, 'sasha_phone', 'Code delivery for real calls: none | twilio_verify. Simulations always use a local test code.'),
  ('sasha.phone.disclosure_text', '"You''ve reached Advantage.Bid. This call is answered by Sasha, our virtual assistant, and is transcribed for customer support."'::jsonb, 'sasha_phone', 'Spoken at the start of every call.'),
  ('sasha.phone.max_concurrent_calls', '10'::jsonb, 'sasha_phone', 'Calls Sasha handles at once; more callers wait in the queue.'),
  ('sasha.phone.daily_budget_usd', '10'::jsonb, 'sasha_phone', 'Model spend cap per UTC day for the phone channel (in addition to the overall Sasha cap).'),
  ('sasha.phone.per_call_budget_usd', '0.75'::jsonb, 'sasha_phone', 'Model spend cap per call; reached → offer a callback from the team.'),
  ('sasha.phone.transcript_retention_days', '90'::jsonb, 'sasha_phone', 'Days a phone transcript is kept; the call summary is kept.'),
  ('sasha.phone.code_ttl_minutes', '10'::jsonb, 'sasha_phone', 'Verification code lifetime.'),
  ('sasha.phone.code_max_attempts', '5'::jsonb, 'sasha_phone', 'Wrong entries allowed per code.'),
  ('sasha.phone.code_max_sends_per_30min', '3'::jsonb, 'sasha_phone', 'Codes per account per 30 minutes.'),
  ('sasha.phone.lockout_minutes', '60'::jsonb, 'sasha_phone', 'Lock after two exhausted codes for an account.'),
  ('sasha.phone.session_max_minutes', '20'::jsonb, 'sasha_phone', 'A verified phone session ends at call end or after this many minutes.'),
  ('sasha.phone.voice', '{"tts_provider": null, "voice": null, "language": "en-US"}'::jsonb, 'sasha_phone', 'Speech voice for real calls (not selected yet).')
ON CONFLICT (key) DO NOTHING;

COMMIT;
