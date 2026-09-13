-- 156_ses_stream_attribution.sql — ADDITIVE + idempotent. Makes SES delivery telemetry attributable to
-- the mail stream that produced it, so Event Partner deliverability can be measured separately from
-- transactional and consumer-marketing mail.
--
-- The gap this closes. Amazon SES puts the configuration set on every event it publishes, at
-- mail.tags['ses:configuration-set']. Our parser discarded it and no column anywhere stored it, so a
-- Delivery from the Event Partner programme was indistinguishable from a Delivery from a marketing
-- campaign. Tagging messages with a dedicated configuration set therefore bought nothing until now.
--
-- What this migration does NOT do: it does not change suppression, complaint, bounce, soft-bounce,
-- unsubscribe or consent behaviour in any way. Attribution is recorded ALONGSIDE those decisions and
-- never participates in them — an Event Partner hard bounce suppresses exactly as it does today.

BEGIN;

-- The SES configuration set that produced the event ('advantage-bid-event-partner',
-- 'advantage-bid-marketing', or NULL for untagged transactional mail).
ALTER TABLE ses_feedback_events ADD COLUMN IF NOT EXISTS configuration_set text;

-- Our own name for the stream, derived from the configuration set at ingest time. Kept separate from
-- the raw SES value so a renamed configuration set does not silently reclassify historical events.
ALTER TABLE ses_feedback_events ADD COLUMN IF NOT EXISTS mail_stream text;

-- SES's own message id, which the per-recipient provider_event_id is derived from. Storing it plainly
-- makes a message traceable across several recipient events.
ALTER TABLE ses_feedback_events ADD COLUMN IF NOT EXISTS ses_message_id text;

CREATE INDEX IF NOT EXISTS idx_ses_feedback_config_set
  ON ses_feedback_events (configuration_set, event_type, received_at DESC)
  WHERE configuration_set IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ses_feedback_stream
  ON ses_feedback_events (mail_stream, event_type, received_at DESC)
  WHERE mail_stream IS NOT NULL;

-- The stream vocabulary is closed, so a typo cannot invent a third reporting bucket.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ses_feedback_mail_stream') THEN
    ALTER TABLE ses_feedback_events
      ADD CONSTRAINT chk_ses_feedback_mail_stream
      CHECK (mail_stream IS NULL OR mail_stream IN ('transactional','marketing','event_partner'));
  END IF;
END $$;

-- Record the Event Partner configuration set name so the application and the reporting layer agree on
-- it without a redeploy. The value must match the set created in SES exactly.
INSERT INTO platform_config (key, value, category) VALUES
  ('email.configuration_sets.event_partner', '"advantage-bid-event-partner"', 'email'),
  ('email.configuration_sets.marketing',     '"advantage-bid-marketing"',     'email')
ON CONFLICT (key) DO NOTHING;

COMMIT;
