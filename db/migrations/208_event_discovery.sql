-- 208: Provider-neutral, consent-based event discovery (owner-approved design, 2026-10-29;
-- docs/projects/provider-neutral-event-discovery-design.md). ADDITIVE / IDEMPOTENT. Moves no money and changes
-- no existing value: no event, source, authorization or consent row is modified.
--   • authorized_event_sources is the ONE authorization record for every company (members included):
--     'member_account' joins the authorization methods (a member authorizing from its own dashboard, trust-ladder
--     Path C); events_page_url is the optional "my events are on this page" a seller may give.
--   • event_collection_channels: how one authorized company's events are collected — a discovered feed, structured
--     data, linked event pages, a confirmed HTML profile, or the company's own push. Each channel records its
--     ACCESS BASIS (the host's permission to read it), separate from the company's distribution authorization.
--   • event_discovery_probes: the history of every automatic, dry-run website check (what was found, what refused).
--   • partner_intake_keys: per-company keys for pushing events to Advantage.Bid (sha256 at rest, shown once).
--   • event_sources.channel_id: which channel an imported event came through (provenance; per-channel health).
-- Rollback (before any channel/probe/key exists): DROP TABLE partner_intake_keys, event_discovery_probes;
--   ALTER TABLE event_sources DROP COLUMN channel_id; DROP TABLE event_collection_channels;
--   ALTER TABLE authorized_event_sources DROP COLUMN events_page_url; restore the method rule from 153.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorized_event_sources_authorization_method_check') THEN
    ALTER TABLE authorized_event_sources DROP CONSTRAINT authorized_event_sources_authorization_method_check;
  END IF;
  ALTER TABLE authorized_event_sources ADD CONSTRAINT authorized_event_sources_authorization_method_check
    CHECK (authorization_method IS NULL OR authorization_method IN
      ('one_click_email','admin_recorded','written_agreement','inbound_request','member_account'));
END $$;

ALTER TABLE authorized_event_sources ADD COLUMN IF NOT EXISTS events_page_url TEXT
  CHECK (events_page_url IS NULL OR (events_page_url ~ '^https?://' AND length(events_page_url) <= 500));

CREATE TABLE IF NOT EXISTS event_collection_channels (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id      UUID NOT NULL REFERENCES authorized_event_sources(id) ON DELETE CASCADE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  import_source_id      UUID REFERENCES import_sources(id) ON DELETE SET NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('ical','rss','jsonld','microdata','linked_pages','platform_endpoint',
                                                      'html_profile','push_api','push_calendar')),
  url                   TEXT CHECK (url IS NULL OR (url ~ '^https?://' AND length(url) <= 1000)),
  sale_type_hint        TEXT CHECK (sale_type_hint IS NULL OR sale_type_hint IN ('auction','estate_sale')),
  timezone              TEXT,
  status                TEXT NOT NULL DEFAULT 'previewed'
                          CHECK (status IN ('previewed','active','paused','blocked','retired')),
  -- The HOST's permission to read this channel — never inferred from the company's distribution authorization.
  access_basis          TEXT NOT NULL CHECK (access_basis IN ('robots_and_terms_permit','host_written_permission',
                                                              'platform_partnership','company_push')),
  access_evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  block_class           TEXT,
  block_evidence        JSONB,
  config                JSONB NOT NULL DEFAULT '{}'::jsonb,     -- reader settings (e.g. listing/sitemap URL, page cap)
  profile               JSONB,                                  -- confirmed HTML extraction profile (html_profile only)
  preview               JSONB NOT NULL DEFAULT '[]'::jsonb,     -- the events a probe saw, for one-time confirmation
  score                 NUMERIC,
  confirmed_by          UUID REFERENCES users(id),
  confirmed_at          TIMESTAMPTZ,
  paused_reason         TEXT,
  discovered_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_probe_at         TIMESTAMPTZ,
  last_read_at          TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_item_count       INTEGER,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind IN ('push_api') OR url IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_collection_channels_kind_url
  ON event_collection_channels (authorization_id, kind, COALESCE(url, ''));
CREATE INDEX IF NOT EXISTS idx_event_collection_channels_source ON event_collection_channels (import_source_id) WHERE import_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_collection_channels_org ON event_collection_channels (organization_id);

CREATE TABLE IF NOT EXISTS event_discovery_probes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id  UUID NOT NULL REFERENCES authorized_event_sources(id) ON DELETE CASCADE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trigger           TEXT NOT NULL CHECK (trigger IN ('authorized','scheduled','admin','failure','seller')),
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('channels_found','blocked','nothing_found','error')),
  requests          INTEGER NOT NULL DEFAULT 0,
  platform          TEXT,
  robots            JSONB,
  blocks            JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidates        JSONB NOT NULL DEFAULT '[]'::jsonb,
  error             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_event_discovery_probes_auth ON event_discovery_probes (authorization_id, started_at DESC);

CREATE TABLE IF NOT EXISTS partner_intake_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id  UUID NOT NULL REFERENCES authorized_event_sources(id) ON DELETE CASCADE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_prefix        TEXT NOT NULL CHECK (key_prefix ~ '^abk_[A-Za-z0-9]{6}$'),
  key_hash          TEXT NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),   -- sha256(raw); the raw key is never stored
  label             TEXT CHECK (label IS NULL OR length(label) <= 80),
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ,
  use_count         INTEGER NOT NULL DEFAULT 0,
  revoked_at        TIMESTAMPTZ,
  revoked_by        UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_partner_intake_keys_auth ON partner_intake_keys (authorization_id);

ALTER TABLE event_sources ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES event_collection_channels(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_event_sources_channel ON event_sources (channel_id) WHERE channel_id IS NOT NULL;

-- Events a company pushes to Advantage.Bid run through the same engine and ledger, recorded as trigger 'push'.
ALTER TABLE import_runs DROP CONSTRAINT IF EXISTS import_runs_trigger_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_trigger_check
  CHECK (trigger IN ('scheduled','manual','backfill','retry','push'));
