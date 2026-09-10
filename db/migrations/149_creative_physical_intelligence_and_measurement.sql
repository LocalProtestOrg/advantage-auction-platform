-- 149: Phase 3P.1 + 3P.2 — physical creative intelligence, Owner gold-standard calibration, and paid-growth
-- measurement readiness (SHADOW / NON-SPENDING). ADDITIVE / IDEMPOTENT. Nothing publishes, sends, activates or spends.
--
-- Creative (3P.1 Mission 1/11, 3P.2 §1–§11):
--   marketing_creative_feedback_records     one row per Owner feedback ledger record (CREATIVE_REVIEW / OWNER_RULE …)
--   marketing_creative_feedback_attributes  attribute-level positive/negative learning (Owner sources only)
--   marketing_creative_feedback_messages    copy the Owner judged — independent of the visual verdict
--   marketing_creative_layout_signatures    + polarity (negative signatures from 'NO' verdicts; τ_neg proximity check)
--   marketing_creative_calibrations         + v2 provenance: media decision, scene plan, physical audit, coverage,
--                                             prominence, event type, capitalization, colour, copy density, logo composite
--                                             + QA, structure, copy profile, judge v2, negative-signature comparison
-- Measurement (3P.2 §12 — first-party truth first; providers are destinations, all OFF):
--   marketing_attribution_touches / _profiles   first-party campaign/session attribution (UTM + click ids + landing)
--   marketing_conversion_events                  the shared conversion ledger (id = provider dedup event_id)
--   assisted_service_inquiries                   the assisted/full-service seller path (availability only; no pricing)
--   marketing_paid_cost_facts                    provider cost ingestion (empty until a channel is Owner-activated)
--   marketing_provider_reconciliations           provider-reported vs first-party outcomes (never silently averaged)
--   marketing_paid_growth_proposals / _campaign_states / _director_actions   Paid Growth Director (shadow mode)

-- ── creative feedback ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_creative_feedback_records (
  record_hash   TEXT PRIMARY KEY,                    -- sha256 of the ledger line (the ledger is the source of truth)
  action        TEXT NOT NULL,
  source        TEXT NOT NULL,
  subject       JSONB NOT NULL DEFAULT '{}',
  verdict       JSONB NOT NULL DEFAULT '{}',
  owner_words   TEXT,
  rules         JSONB NOT NULL DEFAULT '[]',
  recorded_by   TEXT,
  record_ts     TIMESTAMPTZ,
  valid         BOOLEAN NOT NULL DEFAULT true,
  validation_errors JSONB NOT NULL DEFAULT '[]',
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_creative_feedback_attributes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_hash    TEXT NOT NULL REFERENCES marketing_creative_feedback_records(record_hash) ON DELETE CASCADE,
  subject_job_id TEXT,
  subject_candidate TEXT,
  campaign_class TEXT,
  family         TEXT,
  render_sha256  JSONB NOT NULL DEFAULT '[]',
  attribute      TEXT NOT NULL,
  polarity       TEXT NOT NULL CHECK (polarity IN ('positive','negative')),
  severity       TEXT NOT NULL CHECK (severity IN ('required','strong','note')),
  scope          TEXT CHECK (scope IN ('this_creative','campaign_class','family','global')),
  note           TEXT,
  evidence       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (record_hash, attribute, polarity, scope)
);
CREATE INDEX IF NOT EXISTS idx_feedback_attr_class ON marketing_creative_feedback_attributes(campaign_class, attribute);

CREATE TABLE IF NOT EXISTS marketing_creative_feedback_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_hash  TEXT NOT NULL REFERENCES marketing_creative_feedback_records(record_hash) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('OWNER_APPROVED_MESSAGE','OWNER_REJECTED_MESSAGE','USED_NOT_EVALUATED','OWNER_AUTHORED_PHILOSOPHY')),
  scope        TEXT,
  role         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (record_hash, text)
);

ALTER TABLE marketing_creative_layout_signatures ADD COLUMN IF NOT EXISTS polarity TEXT NOT NULL DEFAULT 'positive';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketing_creative_layout_signatures_polarity_chk') THEN
    ALTER TABLE marketing_creative_layout_signatures ADD CONSTRAINT marketing_creative_layout_signatures_polarity_chk CHECK (polarity IN ('positive','negative'));
  END IF;
END $$;

ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS structure             TEXT;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS copy_profile          TEXT;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS media_decision        JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS video_frame_selection JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS scene_plan            JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS physical_audit        JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS coverage              JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS prominence            JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS event_type_check      JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS capitalization        JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS colour                JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS copy_density          JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS logo_composite        JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS logo_qa               JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS negative_signature_check JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS feedback_consulted    JSONB;
ALTER TABLE marketing_creative_calibrations ADD COLUMN IF NOT EXISTS claim_check           JSONB;

-- ── first-party attribution ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_attribution_touches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id      TEXT NOT NULL,
  session_id      TEXT,
  touched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  landing_host    TEXT,
  landing_path    TEXT,
  referrer_host   TEXT,
  channel         TEXT NOT NULL,                     -- paid_social | paid_search | organic_social | email | referral | organic_search | direct
  utm_source      TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  click_type      TEXT CHECK (click_type IS NULL OR click_type IN ('gclid','gbraid','wbraid','fbclid')),
  click_value_sha256 TEXT,                           -- the raw id lives only in marketing_click_ids (4G)
  campaign_key    TEXT,                              -- normalised campaign identity used to join cost ↔ outcomes
  consent_state   JSONB,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  dedup_key       TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_touch_visitor ON marketing_attribution_touches(visitor_id, touched_at);
CREATE INDEX IF NOT EXISTS idx_touch_campaign ON marketing_attribution_touches(campaign_key, touched_at);
CREATE INDEX IF NOT EXISTS idx_touch_user ON marketing_attribution_touches(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketing_attribution_profiles (
  visitor_id         TEXT PRIMARY KEY,
  first_touch_id     UUID REFERENCES marketing_attribution_touches(id) ON DELETE SET NULL,
  last_touch_id      UUID REFERENCES marketing_attribution_touches(id) ON DELETE SET NULL,
  last_paid_touch_id UUID REFERENCES marketing_attribution_touches(id) ON DELETE SET NULL,
  user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  stitched_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attr_profile_user ON marketing_attribution_profiles(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketing_conversion_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- doubles as the provider dedup event_id
  conversion_key   TEXT NOT NULL,                                -- src/lib/conversionDefinitions.js
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  visitor_id       TEXT,
  subject_type     TEXT,
  subject_id       TEXT,
  value_cents      BIGINT,
  currency         TEXT NOT NULL DEFAULT 'USD',
  market           TEXT,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  attribution      JSONB NOT NULL DEFAULT '{}',                  -- first / last / last-paid touch snapshot + class
  consent_state    JSONB,
  provider_dispatch JSONB NOT NULL DEFAULT '{}',                 -- {meta_capi:{status}, google:{status}} — OFF by default
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_key_time ON marketing_conversion_events(conversion_key, occurred_at);
CREATE INDEX IF NOT EXISTS idx_conv_user ON marketing_conversion_events(user_id) WHERE user_id IS NOT NULL;

-- ── assisted / full-service seller path ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assisted_service_inquiries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  city          TEXT,
  state         TEXT,
  market        TEXT,
  seller_path   TEXT NOT NULL DEFAULT 'ASSISTED_FULL_SERVICE' CHECK (seller_path IN ('SELF_SERVICE','ASSISTED_FULL_SERVICE','UNSURE')),
  message       TEXT,
  source_page   TEXT,
  visitor_id    TEXT,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_consent BOOLEAN NOT NULL DEFAULT false,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','evaluating','closed')),
  ip_hash       TEXT
);
CREATE INDEX IF NOT EXISTS idx_assisted_created ON assisted_service_inquiries(created_at);

-- ── paid growth (shadow) ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_paid_cost_facts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL CHECK (provider IN ('meta_ads','google_ads')),
  account_ref   TEXT,
  campaign_id   TEXT NOT NULL,
  campaign_name TEXT,
  campaign_key  TEXT,
  adset_id      TEXT NOT NULL DEFAULT '',
  ad_id         TEXT NOT NULL DEFAULT '',
  fact_date     DATE NOT NULL,
  spend_cents   BIGINT NOT NULL DEFAULT 0,
  impressions   BIGINT NOT NULL DEFAULT 0,
  clicks        BIGINT NOT NULL DEFAULT 0,
  provider_conversions JSONB NOT NULL DEFAULT '{}',
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, campaign_id, adset_id, ad_id, fact_date)
);

CREATE TABLE IF NOT EXISTS marketing_provider_reconciliations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL,
  campaign_key  TEXT NOT NULL,
  window_start  DATE NOT NULL,
  window_end    DATE NOT NULL,
  provider_reported JSONB NOT NULL DEFAULT '{}',
  first_party   JSONB NOT NULL DEFAULT '{}',
  discrepancy   JSONB NOT NULL DEFAULT '{}',
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_paid_growth_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  month           DATE NOT NULL,
  market          TEXT NOT NULL,
  audience        TEXT NOT NULL,
  campaign        TEXT NOT NULL,
  objective       TEXT NOT NULL,
  channel         TEXT NOT NULL,
  budget_cents    BIGINT NOT NULL DEFAULT 0,
  measurement_window_days INTEGER NOT NULL,
  success_signal  TEXT NOT NULL,
  platform_proxy  TEXT,
  stop_condition  TEXT NOT NULL,
  scale_condition TEXT NOT NULL,
  measurement_dependencies JSONB NOT NULL DEFAULT '[]',
  measurement_ready BOOLEAN NOT NULL DEFAULT false,
  unmeasurable    JSONB NOT NULL DEFAULT '[]',
  rationale       TEXT,
  evidence        JSONB NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (state IN ('PROPOSED','OWNER_APPROVED','ACTIVE','PAUSED','STOPPED','REJECTED','SUPERSEDED')),
  mode            TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','live'))
);

CREATE TABLE IF NOT EXISTS marketing_paid_campaign_states (
  campaign_key    TEXT PRIMARY KEY,
  proposal_id     UUID REFERENCES marketing_paid_growth_proposals(id) ON DELETE SET NULL,
  signal_state    TEXT NOT NULL DEFAULT 'NO_DATA' CHECK (signal_state IN ('NO_DATA','INSUFFICIENT_DATA','EARLY_SIGNAL','MEANINGFUL_SIGNAL','WINNER','LOSER')),
  meaningful_checkpoints INTEGER NOT NULL DEFAULT 0,
  checkpoints     JSONB NOT NULL DEFAULT '[]',
  facts           JSONB NOT NULL DEFAULT '{}',
  last_state_change_at TIMESTAMPTZ,
  last_evaluated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS marketing_paid_director_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_key  TEXT,
  action        TEXT NOT NULL CHECK (action IN ('PAUSE_LOSER','SHIFT_BUDGET','TEST_ALTERNATIVE','SCALE_WINNER','STOP_CAMPAIGN','PROPOSE','HOLD')),
  state_before  TEXT,
  state_after   TEXT,
  evidence      JSONB NOT NULL DEFAULT '{}',
  executed      BOOLEAN NOT NULL DEFAULT false,            -- shadow mode: never executed against a provider
  mode          TEXT NOT NULL DEFAULT 'shadow'
);

-- ── configuration (every provider / spend gate OFF) ───────────────────────────────────────────────────────────
INSERT INTO platform_config (key, value, category, description) VALUES
  ('marketing.creative.similarity.tau_neg', '0.30'::jsonb, 'marketing', 'Phase 3P.1: distance to an Owner negative signature below tau_neg is penalised; below tau_neg/2 it hard-fails G11'),
  ('marketing.creative.logo.advantage_bid_led_width_pct', '[30, 50]'::jsonb, 'marketing', 'Phase 3P.2: official logo lockup width band for Advantage.Bid-led creative'),
  ('marketing.paid_growth.monthly_ceiling_usd', '1000'::jsonb, 'marketing', 'Owner Growth Budget CEILING (not a target). The Director may recommend less, including zero.'),
  ('marketing.paid_growth.mode', '"shadow"'::jsonb, 'marketing', 'Paid Growth Director runs in shadow mode: proposals only; no provider action, no spend'),
  ('marketing.measurement.meta_pixel_enabled', 'false'::jsonb, 'marketing', 'Meta Pixel loader (consent-gated). Requires marketing.measurement.meta_dataset_id (Owner).'),
  ('marketing.measurement.meta_capi_enabled', 'false'::jsonb, 'marketing', 'Meta Conversions API dispatch (consent-gated, event_id dedup). Requires dataset id + token (Owner).'),
  ('marketing.measurement.meta_dataset_id', 'null'::jsonb, 'marketing', 'Advantage.Bid Meta Pixel / Dataset id — provider-side Owner action; never a Lewis & Maese asset'),
  ('marketing.measurement.google_conversions_enabled', 'false'::jsonb, 'marketing', 'Google Ads conversion upload (consent-gated). Requires customer id + conversion action ids (Owner).'),
  ('marketing.measurement.google_ads_customer_id', 'null'::jsonb, 'marketing', 'Google Ads customer id — provider-side Owner action'),
  ('marketing.measurement.google_conversion_actions', '{}'::jsonb, 'marketing', 'conversion_key -> Google Ads conversion action resource name (Owner)'),
  ('marketing.assisted_service.markets', '[{"market":"Houston Metro","available":true,"capabilities":["auction creation help","catalog/auction setup assistance","sale management","pickup coordination/handling"],"pricing":"custom_after_evaluation"},{"market":"NYC Tri-State / NYC Metro","available":true,"capabilities":["auction creation help","catalog/auction setup assistance","sale management","pickup coordination/handling"],"pricing":"custom_after_evaluation"}]'::jsonb,
   'marketing', 'Assisted/full-service availability by strategic market (priorities, not permanent restrictions). Pricing is custom after evaluation — never published.')
ON CONFLICT (key) DO NOTHING;
