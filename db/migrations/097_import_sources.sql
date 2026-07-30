-- 097_import_sources.sql — additive + idempotent. Event Import Framework: the source registry.
-- New table only; does NOT touch auctions, bids, payments, sellers, events, or organizations schema.
-- One row per configured import source (§8 of docs/event-import-framework-plan.md). `auth_env_var`
-- stores the NAME of an env var, never a secret. `owner_organization_id` is the canonical owner of
-- events created from this source — resolved at runtime (no UUID is hardcoded in application code).
-- Compliance is a runtime gate (media_policy default link_only; terms_attested_* required before a
-- source may become 'active') — enforced in service code, not here.

BEGIN;

CREATE TABLE IF NOT EXISTS import_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   text        NOT NULL UNIQUE,
  kind                  text        NOT NULL CHECK (kind IN ('csv','rest','rss','xml','json','partner','manual')),
  name                  text        NOT NULL,
  status                text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','disabled')),
  config                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  auth_env_var          text,                                             -- NAME of an env var, never a secret
  owner_organization_id uuid        NOT NULL REFERENCES organizations(id),
  weekly_cap            integer     NOT NULL DEFAULT 75,
  daily_cap             integer,
  max_images_per_event  integer     NOT NULL DEFAULT 40,
  rate_limit_per_min    integer     NOT NULL DEFAULT 60,
  auto_publish          boolean     NOT NULL DEFAULT false,
  media_policy          text        NOT NULL DEFAULT 'link_only' CHECK (media_policy IN ('none','link_only','mirror')),
  terms_attested_by     text,
  terms_attested_at     timestamptz,
  terms_attested_url    text,
  incremental_cursor    text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_sources_status ON import_sources(status);
CREATE INDEX IF NOT EXISTS idx_import_sources_owner  ON import_sources(owner_organization_id);

COMMIT;
