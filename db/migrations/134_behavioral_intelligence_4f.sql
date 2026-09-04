-- 134_behavioral_intelligence_4f.sql — Marketing Agency Phase 4F: first-party behavioral intelligence +
-- retargeting audience engine. ADDITIVE / idempotent / non-destructive. NOTHING here connects Google or
-- Meta, activates A7, sends a campaign, imports a list, or changes any user/seller role. Reuses the raw
-- analytics_events layer + the 4C/4D contact/geo/eligibility model + the Growth Lab.

-- ── 1. Extend the RAW event layer (analytics_events) — do NOT duplicate it ──
-- visitor_id = a durable first-party anonymous id (distinct from the 30-min session_id); page_intent is
-- classified SERVER-SIDE from the path (pageIntentRegistry) so it can't be spoofed; category_key reuses
-- the controlled lot taxonomy. All nullable → existing rows/writers unaffected.
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS visitor_id   TEXT;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS page_intent  TEXT;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS category_key TEXT;
CREATE INDEX IF NOT EXISTS idx_analytics_events_visitor ON analytics_events(visitor_id, received_at DESC) WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_analytics_events_intent  ON analytics_events(page_intent, received_at DESC) WHERE page_intent IS NOT NULL;

-- ── 2. Anonymous → KNOWN identity linkage (explicit, auditable, dedup-safe) ──
-- Populated ONLY by an authoritative first-party action (login/subscribe/register) via an authenticated
-- endpoint — never a silent speculative merge, never client-asserted identity on raw events.
CREATE TABLE IF NOT EXISTS behavioral_identity_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id  TEXT NOT NULL,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  contact_id  UUID REFERENCES marketing_contacts(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,                 -- login | subscribe | register | seller_signup
  confidence  TEXT NOT NULL DEFAULT 'authoritative_action',
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (visitor_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_behavioral_links_user    ON behavioral_identity_links(user_id);
CREATE INDEX IF NOT EXISTS idx_behavioral_links_contact ON behavioral_identity_links(contact_id);

-- ── 3. DERIVED marketing signals (explainable; NOT black-box scores) ──
-- scope: an anonymous visitor, a known user, or a marketing contact. One row per (scope, signal_type),
-- refreshed with recency/frequency/decay. Evidence + reason are always recorded.
CREATE TABLE IF NOT EXISTS marketing_signals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type       TEXT NOT NULL CHECK (scope_type IN ('visitor','user','contact')),
  scope_id         TEXT NOT NULL,
  signal_type      TEXT NOT NULL,
  level            SMALLINT NOT NULL DEFAULT 1,   -- 1 weak .. 4 very high; explainable, not an opaque score
  evidence_count   INTEGER NOT NULL DEFAULT 0,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ,                    -- explicit decay; stale intent is not "high" forever
  derived_by_version TEXT NOT NULL DEFAULT 'v1',
  active           BOOLEAN NOT NULL DEFAULT true,
  reason           TEXT,                           -- human-readable explanation of the evidence
  observed_categories JSONB,                       -- OBSERVED category interest (never inferred traits)
  metadata         JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, signal_type)
);
CREATE INDEX IF NOT EXISTS idx_marketing_signals_type ON marketing_signals(signal_type, active) WHERE active;
CREATE INDEX IF NOT EXISTS idx_marketing_signals_scope ON marketing_signals(scope_type, scope_id);

-- ── 4. Behavioral AUDIENCE membership (definitions live in code/config; this is the membership state) ──
CREATE TABLE IF NOT EXISTS marketing_audience_members (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience_key       TEXT NOT NULL,
  scope_type         TEXT NOT NULL CHECK (scope_type IN ('visitor','user','contact')),
  scope_id           TEXT NOT NULL,
  entered_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_qualified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ,
  exited_at          TIMESTAMPTZ,
  exit_reason        TEXT,                          -- converted | expired | disqualified | suppressed
  evidence           JSONB,
  definition_version TEXT NOT NULL DEFAULT 'v1',
  UNIQUE (audience_key, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_audience_members_active ON marketing_audience_members(audience_key) WHERE exited_at IS NULL;

-- ── 5. Destination sync ledger (provider-neutral; NO provider is connected in this phase) ──
CREATE TABLE IF NOT EXISTS marketing_audience_destinations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience_key          TEXT NOT NULL,
  destination_type      TEXT NOT NULL CHECK (destination_type IN ('a7_email','google_ads','meta','onsite')),
  destination_audience_ref TEXT,                    -- provider-assigned id (never fabricated)
  enabled               BOOLEAN NOT NULL DEFAULT false,   -- OFF until the Owner connects the provider
  sync_status           TEXT NOT NULL DEFAULT 'not_configured',
  last_attempted_at     TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  eligible_count        INTEGER,
  synced_count          INTEGER,
  excluded_count        INTEGER,
  error                 TEXT,
  definition_version    TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audience_key, destination_type)
);

-- ── 6. Config (collection ON; all external destinations OFF; explicit retention/decay defaults) ──
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.behavioral.enabled',            'true'::jsonb,  'marketing'),   -- first-party collection ON
  ('marketing.behavioral.signal_ttl_days',    '45'::jsonb,    'marketing'),   -- derived-signal decay
  ('marketing.behavioral.raw_retention_days', '180'::jsonb,   'marketing'),   -- raw anonymous event retention target
  ('marketing.destinations.google_ads_enabled','false'::jsonb,'marketing'),   -- Google Ads NOT connected
  ('marketing.destinations.meta_enabled',      'false'::jsonb,'marketing')     -- Meta NOT connected
ON CONFLICT (key) DO NOTHING;

-- NOTE: marketing.a7_send_enabled + marketing.admin_sms_enabled remain false (mig 131). Untouched here.
