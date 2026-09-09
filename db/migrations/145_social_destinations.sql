-- 145_social_destinations.sql — Meta organic social multi-market destination registry. ADDITIVE + idempotent.
-- A durable, admin-managed registry of Facebook Pages / Instagram accounts by scope (national/state/regional),
-- so campaign logic NEVER hard-codes a Page identity: the resolver picks an active+ready state destination for
-- the event's geography, else falls back to the national destination. SECRETS ARE NEVER STORED HERE — a
-- destination references the NAME of the env var holding its token (credential_ref); only non-secret provider
-- IDs (Facebook Page ID / Instagram Business Account ID) live in this table. NOTHING here enables publishing
-- (A9 + marketing.destinations.meta_enabled stay OFF); it is inert configuration until the Owner activates.

CREATE TABLE IF NOT EXISTS marketing_social_destinations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform                TEXT NOT NULL CHECK (platform IN ('facebook','instagram')),
  scope                   TEXT NOT NULL DEFAULT 'national' CHECK (scope IN ('national','state','regional')),
  state_code              TEXT,                       -- 2-letter (scope='state'); NULL for national
  market_key              TEXT,                       -- optional regional market identifier
  label                   TEXT NOT NULL,              -- human label, e.g. 'National Facebook', 'Michigan Facebook'
  provider                TEXT NOT NULL DEFAULT 'meta',
  provider_account_id     TEXT,                       -- Facebook Page ID OR Instagram Business Account ID (NON-secret identifier)
  linked_facebook_page_id TEXT,                       -- for instagram: the FB Page it publishes through (Meta requirement)
  credential_ref          TEXT NOT NULL DEFAULT 'META_SYSTEM_USER_TOKEN', -- NAME of the env var holding the token (never the token)
  priority                INTEGER NOT NULL DEFAULT 100, -- lower = preferred within a scope
  active                  BOOLEAN NOT NULL DEFAULT false,
  readiness_status        TEXT NOT NULL DEFAULT 'not_configured'
                            CHECK (readiness_status IN ('not_configured','incomplete','ready','error')),
  readiness_detail        JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One destination per platform + scope + state (national rows share state_code='' via COALESCE).
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_dest ON marketing_social_destinations (platform, scope, COALESCE(state_code, ''));
CREATE INDEX IF NOT EXISTS idx_social_dest_lookup ON marketing_social_destinations (platform, scope, active, readiness_status);

-- Allow the terminal 'published' status for a REAL (non-shadow) provider publish (Wave 2 shipped shadow-only
-- statuses). Additive: widen the CHECK constraint without touching existing rows.
ALTER TABLE marketing_social_jobs DROP CONSTRAINT IF EXISTS marketing_social_jobs_status_check;
ALTER TABLE marketing_social_jobs ADD CONSTRAINT marketing_social_jobs_status_check
  CHECK (status IN ('planned','queued_shadow','published_shadow','published','blocked','failed'));

-- Seed the two national destinations (INACTIVE / not_configured — Owner adds the Page ID + IG account ID + token later).
INSERT INTO marketing_social_destinations (platform, scope, label, credential_ref, priority, active, readiness_status)
VALUES ('facebook', 'national', 'National Facebook', 'META_SYSTEM_USER_TOKEN', 100, false, 'not_configured')
ON CONFLICT (platform, scope, COALESCE(state_code, '')) DO NOTHING;
INSERT INTO marketing_social_destinations (platform, scope, label, credential_ref, priority, active, readiness_status)
VALUES ('instagram', 'national', 'National Instagram', 'META_SYSTEM_USER_TOKEN', 100, false, 'not_configured')
ON CONFLICT (platform, scope, COALESCE(state_code, '')) DO NOTHING;
