-- 153_event_partner_authorization_foundation.sql — ADDITIVE + idempotent. Phase 1 of the Event Partner
-- program: the authorization registry, its hashed single-use tokens, the secure organization-claim token
-- foundation, the HOST organization model for events, and per-event/per-organization analytics columns.
--
-- Deliberately NOT in this migration (Phase 1 is a foundation, not an activation):
--   * No import_sources row is created or activated. Deploying this collects nothing.
--   * No events.organization_id is reassigned. The historical imported events are untouched.
--   * No email is configured, queued or sent. No sender identity. No marketing gate is changed.
--   * No user account, seller profile, capability or membership is created anywhere.
--
-- Separation of concerns: permission to COLLECT and PROMOTE public events (authorized_event_sources) is
-- a distinct record from marketing-email permission (marketing_contacts), from email suppression
-- (email_suppressions), from listing ownership (organization_members / organization_claim_tokens) and
-- from seller activation (organization_capabilities). One action never silently grants another.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. authorized_event_sources — the auditable authorization registry.
-- ---------------------------------------------------------------------------------------------
-- One row per (company, authorized website) permission to collect publicly posted upcoming events.
-- Authorization is NEVER inferred from the existence of a directory listing: a row is created only by
-- an explicit, recorded act, and `status` starts below 'authorized' until that act happens.
--
-- The nine-state lifecycle:
--   prospective       — identified internally; nobody has been contacted yet.
--   invited           — an authorization link was issued to a named recipient (Phase 2 sends it).
--   declined          — the recipient explicitly said no. Terminal until re-invited.
--   expired           — the invitation lapsed unused. Terminal until re-invited.
--   authorized        — permission granted and evidenced. Collection is ELIGIBLE, not yet configured.
--   source_configured — an import_sources row exists for this company and passed safety validation.
--   collecting        — the source is active and may run on schedule.
--   paused            — temporarily halted (by us or the company). Reversible to 'collecting'.
--   revoked           — permission withdrawn. Terminal; the source is disabled and never re-runs.
CREATE TABLE IF NOT EXISTS authorized_event_sources (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                 uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Company identity snapshot AS STATED AT INVITATION TIME. Kept alongside the FK so the evidence
  -- record stays truthful even if the organization is later renamed or merged.
  company_name                    text        NOT NULL,
  -- The authorized website. `authorized_domain` is the registrable host (lowercase, no scheme/path)
  -- and is the unit of permission; `authorized_source_url` is an optional specific page or feed.
  authorized_domain               text        NOT NULL,
  authorized_source_url           text,
  -- Intended recipient of the authorization link. NULL for methods where no email was involved
  -- (e.g. a countersigned written agreement recorded by an administrator).
  invited_email                   text,
  invited_email_normalized        text,
  status                          text        NOT NULL DEFAULT 'prospective'
    CHECK (status IN ('prospective','invited','declined','expired','authorized',
                      'source_configured','collecting','paused','revoked')),
  authorization_method            text
    CHECK (authorization_method IS NULL OR authorization_method IN
          ('one_click_email','admin_recorded','written_agreement','inbound_request')),
  authorized_at                   timestamptz,
  -- Evidence of the granting act. IP is one-way hashed (never stored raw), consistent with
  -- analytics_events.ip_hash. `authorization_evidence` carries the machine-readable record:
  -- the exact statement shown, the token id consumed, the recipient binding and the request context.
  authorized_ip_hash              text,
  authorized_user_agent           text,
  authorization_statement_version text,
  authorization_evidence          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Revocation is a first-class concept, entirely separate from a marketing-email unsubscribe.
  revoked_at                      timestamptz,
  revoked_reason                  text,
  revoked_by                      uuid        REFERENCES users(id),
  revoked_via                     text
    CHECK (revoked_via IS NULL OR revoked_via IN ('company_request','admin','token_link','compliance')),
  -- The per-company import source, once configured. ON DELETE SET NULL: losing a source row must
  -- never destroy the authorization evidence.
  import_source_id                uuid        REFERENCES import_sources(id) ON DELETE SET NULL,
  -- Safety validation of the source (robots, terms, attribution, real-image policy) — recorded here
  -- so a source can never be promoted to 'collecting' on an unvalidated basis.
  source_validated_at             timestamptz,
  source_validation               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_collection_at              timestamptz,
  notes                           text,
  created_by                      uuid        REFERENCES users(id),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

-- At most ONE live authorization per (company, domain). Terminal states are excluded so a revoked or
-- lapsed record is preserved forever as evidence while the company can still be re-invited later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_authorized_event_sources_live
  ON authorized_event_sources (organization_id, authorized_domain)
  WHERE status NOT IN ('revoked','declined','expired');

CREATE INDEX IF NOT EXISTS idx_authorized_event_sources_org    ON authorized_event_sources(organization_id);
CREATE INDEX IF NOT EXISTS idx_authorized_event_sources_status ON authorized_event_sources(status);
CREATE INDEX IF NOT EXISTS idx_authorized_event_sources_source ON authorized_event_sources(import_source_id)
  WHERE import_source_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. event_partner_authorization_tokens — hashed, expiring, single-use authorization links.
-- ---------------------------------------------------------------------------------------------
-- The raw token is returned to the caller EXACTLY ONCE at mint time and is never stored: only
-- sha256(raw) is persisted, so a database disclosure cannot forge an authorization. Single-use is
-- enforced atomically by a conditional UPDATE on used_at (see authorizationService.consumeToken).
-- Replay protection: a consumed or expired token can never grant again, and every failed presentation
-- increments `attempts` so brute force is visible and rate-limitable.
CREATE TABLE IF NOT EXISTS event_partner_authorization_tokens (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id           uuid        NOT NULL REFERENCES authorized_event_sources(id) ON DELETE CASCADE,
  organization_id            uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash                 text        NOT NULL UNIQUE,   -- sha256(raw token); raw NEVER stored
  -- Recipient binding: the token is valid only for the authorization context it was minted for.
  recipient_email_normalized text,
  purpose                    text        NOT NULL DEFAULT 'authorize'
    CHECK (purpose IN ('authorize','revoke')),
  expires_at                 timestamptz NOT NULL,
  used_at                    timestamptz,
  used_ip_hash               text,
  used_user_agent            text,
  attempts                   integer     NOT NULL DEFAULT 0,
  issued_by                  uuid        REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ep_auth_tokens_authorization ON event_partner_authorization_tokens(authorization_id);
CREATE INDEX IF NOT EXISTS idx_ep_auth_tokens_expires       ON event_partner_authorization_tokens(expires_at);

-- ---------------------------------------------------------------------------------------------
-- 3. organization_claim_tokens — the secure claim foundation.
-- ---------------------------------------------------------------------------------------------
-- Closes the first-authenticated-user-wins weakness in POST /api/org/claim/:orgId. A claim token is
-- bound to ONE intended recipient email, hashed at rest, expiring, single-use and replay-protected.
-- Redemption additionally requires that the signed-in user's VERIFIED email match the binding, so
-- possession of the link alone is not sufficient.
CREATE TABLE IF NOT EXISTS organization_claim_tokens (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash               text        NOT NULL UNIQUE,     -- sha256(raw token); raw NEVER stored
  invited_email_normalized text        NOT NULL,            -- intended recipient binding (required)
  expires_at               timestamptz NOT NULL,
  used_at                  timestamptz,
  used_by_user_id          uuid        REFERENCES users(id),
  used_ip_hash             text,
  attempts                 integer     NOT NULL DEFAULT 0,
  issued_by                uuid        REFERENCES users(id),
  issue_reason             text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_claim_tokens_org     ON organization_claim_tokens(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_claim_tokens_expires ON organization_claim_tokens(expires_at);

-- Records WHY a claim was permitted or refused, for every claim attempt from now on. Append-only
-- evidence; a granted claim that cannot produce a proof row must not happen.
CREATE TABLE IF NOT EXISTS organization_claim_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid        REFERENCES users(id) ON DELETE SET NULL,
  outcome          text        NOT NULL CHECK (outcome IN ('granted','denied')),
  proof_method     text        NOT NULL
    CHECK (proof_method IN ('claim_token','verified_email_domain','admin_override','none')),
  denial_code      text,
  claim_token_id   uuid        REFERENCES organization_claim_tokens(id) ON DELETE SET NULL,
  ip_hash          text,
  detail           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_claim_attempts_org ON organization_claim_attempts(organization_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- 4. HOST ORGANIZATION MODEL — events.host_organization_id.
-- ---------------------------------------------------------------------------------------------
-- Decision: ADD a separate column rather than overload events.organization_id.
--
--   events.organization_id      = the OPERATING owner of the record. For an imported event this is the
--                                 importing organization (import_sources.owner_organization_id, in
--                                 practice the Advantage platform tenant). It drives tenant scoping,
--                                 admin ownership and the "imports never consume seller plan quotas"
--                                 invariant, and the import writer deliberately forbids updating it.
--   events.host_organization_id = WHO CONDUCTED THE SALE. An attribution/display fact. An estate sale
--                                 run by ABC Estate Sales belongs under ABC Estate Sales even though
--                                 Advantage.Bid infrastructure performed the import.
--
-- Keeping them separate means: no historical rewrite, no change to tenant scoping or quota behavior,
-- and no ambiguity about which organization is accountable for the record versus which company the
-- public sees. host_organization_id is NULL for every existing row and is only ever set through a
-- proven association (see host_attribution_method) — never guessed, never bulk-assigned.
ALTER TABLE events ADD COLUMN IF NOT EXISTS host_organization_id    uuid REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS host_attribution_method text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS host_attributed_at      timestamptz;
ALTER TABLE events ADD COLUMN IF NOT EXISTS host_attributed_by      uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_events_host_org ON events(host_organization_id)
  WHERE host_organization_id IS NOT NULL;

-- A host may not be recorded without saying how it was proven, and the method vocabulary is closed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_events_host_attribution_method') THEN
    ALTER TABLE events
      ADD CONSTRAINT chk_events_host_attribution_method
      CHECK (host_attribution_method IS NULL OR host_attribution_method IN
            ('authorized_source','organization_authored','admin_verified','claim_verified'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_events_host_requires_method') THEN
    ALTER TABLE events
      ADD CONSTRAINT chk_events_host_requires_method
      CHECK (host_organization_id IS NULL OR host_attribution_method IS NOT NULL);
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 5. ANALYTICS — per-event and per-organization attribution.
-- ---------------------------------------------------------------------------------------------
-- analytics_events could previously attribute only to an auction or a seller, so no event page view
-- or outbound click could ever be counted for a company. These two columns close that gap. They are
-- nullable and additive: every existing writer and reader is unaffected.
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS event_id        uuid;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS idx_analytics_events_event ON analytics_events(event_id, event_type)
  WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_analytics_events_org   ON analytics_events(organization_id, event_type)
  WHERE organization_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 6. A15 Event Partner Outreach — registered, deliberately powerless.
-- ---------------------------------------------------------------------------------------------
-- Identity + capability definition only. can_publish / can_spend / can_review are all false and its
-- capability list contains no send, publish, authorize or claim verb. Phase 1 gives A15 the ability to
-- DRAFT and PROPOSE and to READ partner metrics — nothing that reaches a company.
INSERT INTO marketing_agents (agent_key, code, display_name, tier, capabilities, can_publish, can_spend, can_review) VALUES
  ('a15_event_partner', 'A15', 'Event Partner Outreach', 'growth',
   '["draft_partner_outreach","propose_partner_outreach","read_partner_metrics"]', false, false, false)
ON CONFLICT (agent_key) DO UPDATE SET
  code = EXCLUDED.code, tier = EXCLUDED.tier, display_name = EXCLUDED.display_name,
  capabilities = EXCLUDED.capabilities, can_publish = EXCLUDED.can_publish,
  can_spend = EXCLUDED.can_spend, can_review = EXCLUDED.can_review;

-- ---------------------------------------------------------------------------------------------
-- 7. Owner-controlled gates. Every one of these ships OFF/dormant.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform_config (key, value, category) VALUES
  -- Master switch. OFF: no authorization link can be minted or redeemed in production.
  ('event_partners.enabled',                'false', 'event_partners'),
  -- A company source may never run on schedule until BOTH this gate and per-source validation pass.
  ('event_partners.collection_enabled',     'false', 'event_partners'),
  -- Phase 2. No outreach of any kind is possible while this is false.
  ('event_partners.outreach_enabled',       'false', 'event_partners'),
  -- The Owner's "never boast about weak statistics" rule. A performance claim is eligible only when
  -- the relevant first-party metric reaches this value. Never round up, never estimate.
  ('event_partners.performance_min_metric', '100',   'event_partners'),
  -- Authorization links are short-lived by default (days).
  ('event_partners.token_ttl_days',         '30',    'event_partners'),
  -- Claim links are shorter still (days).
  ('event_partners.claim_token_ttl_days',   '14',    'event_partners'),
  -- Claim security. 'token_or_verified_domain' is the Phase 1 default and closes first-user-wins;
  -- 'token_only' is the strictest setting. Event Partner organizations always require a token.
  ('organizations.claim_proof_policy',      '"token_or_verified_domain"', 'security')
ON CONFLICT (key) DO NOTHING;

COMMIT;
