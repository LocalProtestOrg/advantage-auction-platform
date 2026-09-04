-- 133_email_delivery_local_alerts_4e.sql — Marketing Agency Phase 4E: first-party email delivery,
-- local event alerts & A7 readiness. ADDITIVE / idempotent / non-destructive. NOTHING here activates
-- A7 (marketing.a7_send_enabled stays false), imports any list, or sends any real campaign. Reuses the
-- 4C/4D contact + eligibility + suppression architecture.

-- ── 1. Frequency safety config (per-day + per-week caps; extends the 4C 30-day cap + spacing) ──
-- Conservative defaults: at most 1 marketing email/day, 3/rolling-7-days. Optimize engagement, not volume.
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.email.max_per_day',              '1'::jsonb,  'marketing'),
  ('marketing.email.max_per_7d',               '3'::jsonb,  'marketing'),
  ('marketing.email.local_alert_default_radius_miles', '50'::jsonb, 'marketing'),
  ('marketing.email.duplicate_event_days',     '30'::jsonb, 'marketing')  -- never re-alert same contact re same event within N days
ON CONFLICT (key) DO NOTHING;

-- ── 2. Test-send audit trail (internal TEST sends are auditable but NEVER consume subscriber audience) ──
CREATE TABLE IF NOT EXISTS marketing_test_sends (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_class TEXT NOT NULL,
  event_kind     TEXT,                      -- auction | estate_sale | partner_event | digest
  event_ref      TEXT,                      -- auction uuid or event slug (or 'digest')
  subject        TEXT,
  to_addresses   TEXT[] NOT NULL,           -- explicit internal/test addresses only
  sent_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  provider_result JSONB,                    -- messageId(s) / skipped
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_test_sends_created ON marketing_test_sends(created_at DESC);

-- ── 3. Marketing email send log (delivery analytics for the GATED live path; distinct from test sends) ──
-- Rows are only written by the gated live-send path (inert until a7_send_enabled). Idempotency for the
-- recipient set itself remains marketing_campaign_recipients (4C, UNIQUE(campaign_id,contact_id)).
CREATE TABLE IF NOT EXISTS marketing_email_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID,                      -- references marketing_campaigns(id) when persisted
  contact_id     UUID,                      -- references marketing_contacts(id)
  normalized_email TEXT,
  event_type     TEXT NOT NULL CHECK (event_type IN ('queued','attempted','delivered','bounced','complained','unsubscribed','clicked')),
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_email_events_campaign ON marketing_email_events(campaign_id, event_type);
CREATE INDEX IF NOT EXISTS idx_marketing_email_events_contact  ON marketing_email_events(contact_id);

-- NOTE: marketing.a7_send_enabled and marketing.admin_sms_enabled remain false (seeded in mig 131).
-- This migration deliberately does NOT touch them.
