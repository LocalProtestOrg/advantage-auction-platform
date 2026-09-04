-- 135_director_bridge_consent_onsite_4g.sql — Marketing Agency Phase 4G: Marketing Director operating
-- bridge + consent + onsite execution. ADDITIVE / idempotent / non-destructive. NOTHING here connects
-- Google or Meta, activates A7, sends any message, spends money, or imports a list. Only ONSITE may
-- execute (gated). Reuses the 4F behavioral engine + 4B Growth Lab + 4C/4D/4E contact/email model.

-- ── 1. CONSENT — first-class, append-only history (NOT the same as email marketing permission) ──
-- Categories: essential | analytics | personalization | advertising. Each row is an immutable event;
-- the CURRENT state per (scope, category) is the most recent row. No dark patterns; advertising defaults
-- to denied until explicitly granted.
CREATE TABLE IF NOT EXISTS consent_records (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('visitor','user')),
  scope_id       TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('essential','analytics','personalization','advertising')),
  state          TEXT NOT NULL CHECK (state IN ('granted','denied','withdrawn')),
  source         TEXT NOT NULL,                 -- banner | preferences | api | default
  policy_version TEXT NOT NULL DEFAULT 'v1',
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consent_records_scope ON consent_records(scope_type, scope_id, category, created_at DESC);

-- ── 2. Stamp consent at WRITE TIME on behavioral events (no retroactive invention) ──
-- Nullable JSONB snapshot of the consent that applied when the event was written. Historical rows stay NULL.
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS consent_state JSONB;

-- ── 3. CLICK-ID capture (provider-neutral, first-party, server-side). Capture != authorized use. ──
CREATE TABLE IF NOT EXISTS marketing_click_ids (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type    TEXT NOT NULL DEFAULT 'visitor' CHECK (scope_type IN ('visitor','user')),
  scope_id      TEXT NOT NULL,                  -- visitor_id at capture
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,   -- linked later on authoritative action
  click_type    TEXT NOT NULL CHECK (click_type IN ('gclid','gbraid','wbraid','fbclid')),
  click_value   TEXT NOT NULL,
  source        TEXT,                           -- landing_url host / referrer class
  consent_state JSONB,                          -- consent at capture time
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_id, click_type, click_value)     -- dedup-safe
);
CREATE INDEX IF NOT EXISTS idx_click_ids_user ON marketing_click_ids(user_id) WHERE user_id IS NOT NULL;

-- ── 4. OPPORTUNITIES — detected fact + why-actionable (deterministic, not agent opinion) ──
CREATE TABLE IF NOT EXISTS marketing_opportunities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_type TEXT NOT NULL,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  objective        TEXT,
  subject_ref      TEXT,                         -- e.g. audience_key, auction id, page path
  evidence         JSONB NOT NULL DEFAULT '{}',
  size_estimate    INTEGER,
  time_criticality TEXT NOT NULL DEFAULT 'none' CHECK (time_criticality IN ('none','low','medium','high','urgent')),
  influenceability TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (influenceability IN ('marketing_influenceable','not_a_marketing_constraint','unknown')),
  detector_version TEXT NOT NULL DEFAULT 'v1',
  status           TEXT NOT NULL DEFAULT 'detected'
                     CHECK (status IN ('detected','feasible','declined','ranked','decided','expired')),
  decline_reason   TEXT,
  rank_index       INTEGER,
  ranking_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON marketing_opportunities(status, detected_at DESC);

-- ── 5. DIRECTOR DECISION RECORDS (declines are first-class; append-only audit) ──
CREATE TABLE IF NOT EXISTS marketing_decisions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id     UUID REFERENCES marketing_opportunities(id) ON DELETE SET NULL,
  decision           TEXT NOT NULL CHECK (decision IN ('pursue','decline','wait','prepare','escalate','stop','scale','modify')),
  decision_reason    TEXT,
  objective          TEXT,
  audience_key       TEXT,
  channel            TEXT,
  evidence           JSONB,
  hypothesis         TEXT,
  outcome_definition TEXT,
  stop_condition     TEXT,
  scale_condition    TEXT,
  exclusions         TEXT,
  created_by         TEXT NOT NULL DEFAULT 'A1',
  experiment_id      UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decisions_opportunity ON marketing_decisions(opportunity_id, created_at DESC);

-- ── 6. ONSITE treatment log (one treatment per page view; auditable) ──
CREATE TABLE IF NOT EXISTS marketing_onsite_treatments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playbook_key   TEXT NOT NULL,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('visitor','user')),
  scope_id       TEXT NOT NULL,
  page_path      TEXT,
  audience_key   TEXT,
  treatment_version TEXT NOT NULL DEFAULT 'v1',
  reason         TEXT,
  shown_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_onsite_treatments_scope ON marketing_onsite_treatments(scope_type, scope_id, shown_at DESC);

-- ── 7. Config: onsite ON (gated by executionAuthorization); consent policy; providers stay OFF ──
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.onsite.enabled',        'true'::jsonb,  'marketing'),   -- ONLY onsite may execute this phase
  ('marketing.consent.policy_version','"v1"'::jsonb,  'marketing'),
  ('marketing.consent.required_for_advertising','true'::jsonb, 'marketing'),
  ('marketing.click_ids.retention_days','180'::jsonb, 'marketing'),
  ('marketing.onsite.max_per_pageview', '1'::jsonb,   'marketing')
ON CONFLICT (key) DO NOTHING;

-- NOTE: a7_send_enabled, admin_sms_enabled, destinations.google_ads_enabled, destinations.meta_enabled
-- ALL remain false (migs 131/134). This migration does NOT touch them.
