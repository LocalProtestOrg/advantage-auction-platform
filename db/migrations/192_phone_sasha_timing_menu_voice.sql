-- 192_phone_sasha_timing_menu_voice.sql
-- Phone Sasha conversational UX: per-turn latency / interruption timing events, and a menu voice separate from Sasha's.
--
--   cs_call_timing_events  one row per measured moment in a live or simulated call turn: transcript received, model
--                          request, first model output, first sentence sent, tool start / end, interruption received,
--                          generation aborted, turn complete. Timing and counts only: never caller words, audio, codes
--                          or account data (detail holds e.g. tool name, milliseconds, character counts).
--   platform_config        sasha.phone.menu_voice: the routing menu's <Say> voice (British female), so the menu and
--                          Sasha no longer share one fallback. Sasha's own voice (sasha.phone.voice) is unchanged.
--
-- Nothing is switched on or off. Rollback: DROP TABLE cs_call_timing_events; DELETE FROM platform_config WHERE key = 'sasha.phone.menu_voice';

BEGIN;

CREATE TABLE IF NOT EXISTS cs_call_timing_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id            uuid NOT NULL REFERENCES cs_calls(id) ON DELETE CASCADE,
  turn_id            uuid,
  event              text NOT NULL CHECK (event IN ('transcript_received', 'model_request', 'first_output', 'first_audio_sent', 'first_sentence_sent',
                       'tool_start', 'tool_end', 'interrupt_received', 'generation_aborted', 'turn_complete')),
  at                 timestamptz NOT NULL DEFAULT now(),
  ms_from_turn_start integer,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_cs_call_timing_events_call ON cs_call_timing_events (call_id, at);

INSERT INTO platform_config (key, value, category, description) VALUES
  ('sasha.phone.menu_voice', '{"tts_provider": "Amazon", "voice": "Amy-Generative", "language": "en-GB"}'::jsonb, 'sasha_phone',
   'Voice for the routing menu and short call messages (<Say>): British female. Separate from Sasha''s voice.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
