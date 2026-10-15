-- 196_sasha_staff_alerts.sql — immediate staff notifications for actionable Sasha messages (owner request 2026-10-15).
--
-- An actionable message is a hand-off to a person (chat, email or phone) or a phone callback request; it is already
-- recorded in the secure staff inbox (cs_handoffs / cs_conversations) before any notification is attempted, so the
-- message is kept even when every notification fails.
--
-- cs_staff_alerts is the delivery log AND the de-duplication key: one row per (hand-off, kind, channel, recipient).
-- Only the request that inserts the row sends; a failed row is retried by the worker (bounded attempts). Recipients
-- live in platform_config ('sasha.staff_alert_emails', 'sasha.staff_alert_sms'), editable by a Super Admin; they are
-- not stored in this file. Additive only.

CREATE TABLE IF NOT EXISTS cs_staff_alerts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id           uuid NOT NULL REFERENCES cs_handoffs(id) ON DELETE CASCADE,
  conversation_id      uuid REFERENCES cs_conversations(id) ON DELETE SET NULL,
  kind                 text NOT NULL CHECK (kind IN ('handoff', 'callback')),
  channel              text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient            text NOT NULL,          -- a staff address / number from the Super Admin recipient list
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'gave_up')),
  attempts             integer NOT NULL DEFAULT 0,
  provider_message_id  text,                   -- SES message id / Twilio SID
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  UNIQUE (handoff_id, kind, channel, recipient)
);
CREATE INDEX IF NOT EXISTS idx_cs_staff_alerts_retry ON cs_staff_alerts (status, updated_at) WHERE status IN ('pending', 'sending', 'failed');
CREATE INDEX IF NOT EXISTS idx_cs_staff_alerts_recent ON cs_staff_alerts (created_at DESC);
