-- 131_email_audience_safety_4c.sql — Marketing Agency Phase 4C: email/audience SAFETY foundation.
-- ADDITIVE / idempotent / non-destructive. NOTHING here activates sending, import, or SMS. Makes future
-- email SAFE before powerful: SES feedback ingestion, normalized suppression, generic marketing contacts +
-- source + permission (source != permission; default unknown), deliverability state, campaign recipient
-- idempotency, and email/A7 gating config. Reuses recipientService + the existing import framework.

-- ── 1. Normalize the existing suppression store (0 rows in prod; safe). Suppression is TERMINAL. ──
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS normalized_email TEXT;
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS source           TEXT;
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS provider         TEXT;
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS scope            TEXT NOT NULL DEFAULT 'marketing';
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS evidence_ref     TEXT;
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE email_suppressions SET normalized_email = lower(btrim(email)) WHERE normalized_email IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_suppressions_normalized ON email_suppressions(normalized_email);

-- ── 2. SES feedback events (raw, idempotent) + per-address deliverability state ──────
CREATE TABLE IF NOT EXISTS ses_feedback_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type       TEXT NOT NULL,               -- Bounce | Complaint | Delivery | (SoftBounce derived)
  bounce_subtype   TEXT,                         -- Permanent | Transient | ...
  normalized_email TEXT,
  provider_event_id TEXT UNIQUE,                 -- idempotency (SES messageId + recipient)
  raw              JSONB,                        -- provider evidence (no secrets)
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ses_feedback_email ON ses_feedback_events(normalized_email);

CREATE TABLE IF NOT EXISTS email_deliverability (
  normalized_email    TEXT PRIMARY KEY,
  hard_bounced        BOOLEAN NOT NULL DEFAULT false,
  complaint           BOOLEAN NOT NULL DEFAULT false,
  invalid             BOOLEAN NOT NULL DEFAULT false,
  soft_bounce_count   INTEGER NOT NULL DEFAULT 0,
  last_soft_bounce_at TIMESTAMPTZ,
  last_delivery_at    TIMESTAMPTZ,
  last_event_ref      TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 3. Generic marketing contacts + sources + permission (source != permission) ─────
CREATE TABLE IF NOT EXISTS marketing_contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email TEXT NOT NULL UNIQUE,         -- canonical dedup key
  preferred_email  TEXT,                          -- original/source-supplied address
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  full_name        TEXT,
  city             TEXT,
  address_state    TEXT,
  zip              TEXT,
  is_demo          BOOLEAN NOT NULL DEFAULT false,
  -- permission is EVIDENCE-DRIVEN. Default unknown: existence/registration/purchase/CRM presence never promote it.
  permission_basis TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (permission_basis IN ('unknown','platform_relationship','explicit_opt_in','follower_optin','withdrawn')),
  permission_scope JSONB,                         -- which marketing classes are permitted, w/ evidence
  permission_evidence TEXT,
  permission_established_at TIMESTAMPTZ,
  permission_withdrawn_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_contact_sources (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       UUID NOT NULL REFERENCES marketing_contacts(id) ON DELETE CASCADE,
  source_type      TEXT NOT NULL CHECK (source_type IN
                     ('platform_buyer','platform_seller','newsletter_signup','seller_follower','legacy_import',
                      'professional_prospect','purchased_audience','new_mover','partner_referral','manual_entry')),
  source_record_id TEXT,
  import_source_id UUID,
  import_run_id    UUID,
  import_run_item_id UUID,
  original_email   TEXT,
  acquisition_date TIMESTAMPTZ,                   -- NULL when genuinely unknown (never manufactured)
  consent_evidence TEXT,
  vendor_permitted_uses JSONB,                    -- e.g. {ad_audience, postal, email, enrichment} — evidence, NOT consent
  batch_ref        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id, source_type, source_record_id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_contact_sources_contact ON marketing_contact_sources(contact_id);

-- ── 4. Campaign recipient idempotency (extends the certified marketing_campaigns) ────
CREATE TABLE IF NOT EXISTS marketing_campaign_recipients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES marketing_contacts(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'selected' CHECK (status IN ('selected','queued','sent','failed','suppressed_at_send')),
  provider_status TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)              -- retries never duplicate a recipient
);

-- ── 5. Config: gates (all OFF) + email geography/frequency (SEPARATE from paid 30-mile) ──
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.a7_send_enabled',            'false'::jsonb, 'marketing'),   -- A7 autonomous email sending OFF
  ('marketing.admin_sms_enabled',          'false'::jsonb, 'marketing'),   -- Admin Quick-Contact SMS gated (Twilio pending)
  ('marketing.email.default_geo_strategy', '"nationwide_or_interest"'::jsonb, 'marketing'),
  ('marketing.email.frequency_cap_per_30d','4'::jsonb,     'marketing'),
  ('marketing.email.min_spacing_hours',    '48'::jsonb,    'marketing'),
  ('marketing.email.soft_bounce_suppress_threshold','4'::jsonb, 'marketing'),
  ('marketing.email.complaint_class_halt_threshold_bps','30'::jsonb, 'marketing') -- 0.30% complaint → class halt
ON CONFLICT (key) DO NOTHING;
