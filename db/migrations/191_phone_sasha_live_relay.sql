-- 191_phone_sasha_live_relay.sql
-- Live Twilio ConversationRelay connection for Phone Sasha: routing menu, staff-only testing, owner-approved greeting.
-- NOTHING IS SWITCHED ON. sasha.phone.enabled stays false and sasha.phone.provider stays 'none'; while either is off,
-- every call to the voice webhook hears a short "not available" message and ends. When it is later switched on for a
-- controlled test, sasha.phone.access_mode = 'staff_only' means only numbers on cs_phone_test_callers reach Sasha.
--
--   cs_calls.routing_reason   the caller's menu choice: buyer (1), seller (2), pickup (3), other (4)
--   cs_phone_test_callers     staff/test caller allowlist for the testing phase. Stores a salted hash and the last 4
--                             digits only (never the full number). Removing a number keeps the row (removed_at).
--   platform_config           sasha.phone.access_mode, greeting, menu_text, call_notice (empty: nothing is added
--                             before the menu unless the owner sets it).
--
-- The old sasha.phone.disclosure_text row is left in place for history; it is no longer spoken (owner direction
-- 2026-10-08: the call opens with the Advantage.Bid menu and Sasha's greeting, with no assistant-type announcement).
--
-- Rollback: DROP TABLE cs_phone_test_callers; ALTER TABLE cs_calls DROP COLUMN routing_reason;
--   DELETE FROM platform_config WHERE key IN ('sasha.phone.access_mode','sasha.phone.greeting','sasha.phone.menu_text','sasha.phone.call_notice');

BEGIN;

ALTER TABLE cs_calls ADD COLUMN IF NOT EXISTS routing_reason text;
ALTER TABLE cs_calls DROP CONSTRAINT IF EXISTS cs_calls_routing_reason_check;
ALTER TABLE cs_calls ADD CONSTRAINT cs_calls_routing_reason_check CHECK (routing_reason IS NULL OR routing_reason IN ('buyer', 'seller', 'pickup', 'other'));

CREATE TABLE IF NOT EXISTS cs_phone_test_callers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash  text NOT NULL,
  phone_last4 text NOT NULL,
  label       text,
  added_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  removed_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_phone_test_callers_active ON cs_phone_test_callers (phone_hash) WHERE removed_at IS NULL;

INSERT INTO platform_config (key, value, category, description) VALUES
  ('sasha.phone.access_mode', '"staff_only"'::jsonb, 'sasha_phone', 'Who reaches Sasha when the phone line is on: staff_only (only the test-caller allowlist) | public.'),
  ('sasha.phone.greeting', '"Thank you for calling Advantage.Bid. This is Sasha. How can I help you today?"'::jsonb, 'sasha_phone', 'What Sasha says when she joins the call.'),
  ('sasha.phone.menu_text', '"Thank you for calling Advantage.Bid, where you always get the advantage!\nIf you are a buyer, please press 1.\nIf you are a seller, please press 2.\nIf you have recently purchased and need assistance with pickup, please press 3.\nFor all other questions, please press 4."'::jsonb, 'sasha_phone', 'The routing menu, one spoken line per row.'),
  ('sasha.phone.call_notice', '""'::jsonb, 'sasha_phone', 'Optional notice spoken before the menu. Empty: nothing is added.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
