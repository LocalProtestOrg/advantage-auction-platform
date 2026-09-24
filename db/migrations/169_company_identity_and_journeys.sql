-- 169_company_identity_and_journeys.sql — ADDITIVE + idempotent.
--
-- CLAIMED LISTING ACTIVATION (gate L-A): one business, many records, exactly one acquisition journey.
--
--   • company_identities / company_identity_links tie together every record that refers to the same
--     business (Railway organization, sales prospect, Event Partner source, professional seller
--     profile, BD member). Links are made ONLY on a strong signal or by an administrator; a weak
--     resemblance is written to company_identity_reviews and never merged automatically.
--   • acquisition_journey_assignments: at most ONE active journey per company (partial unique index).
--     A company in the CLAIMED_LISTING journey can never receive cold Event Partner outreach.
--   • Event Partner screening gains EXCLUDE_LISTING_JOURNEY.
--   • organization_claim_tokens.issue_channel records how a claim link was issued.
--   • organizations.acquisition / seller_profiles.acquisition carry the server-controlled hard
--     attribution record (journey, cohort, sequence, message, template, token, proof method).
--
-- Nothing here deletes, merges or rewrites existing business data. No Event Partner row is written.

BEGIN;

CREATE TABLE IF NOT EXISTS company_identities (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name           text NOT NULL,
  normalized_name        text,
  root_domain            text,
  corporate_email_domain text,
  normalized_phone       text,
  google_place_id        text,
  bd_listing_id          text,
  primary_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_identities_domain ON company_identities (root_domain) WHERE root_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_company_identities_phone  ON company_identities (normalized_phone) WHERE normalized_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_company_identities_name   ON company_identities (normalized_name) WHERE normalized_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS company_identity_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES company_identities(id) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN
                 ('organization','sales_prospect','authorized_event_source','seller_profile','bd_member')),
  entity_id    text NOT NULL,
  match_method text NOT NULL CHECK (match_method IN
                 ('bd_listing_id','google_place_id','root_domain','corporate_email_domain','phone','exact_name','admin','seed')),
  confidence   text NOT NULL CHECK (confidence IN ('strong','admin')),
  linked_at    timestamptz NOT NULL DEFAULT now(),
  linked_by    uuid REFERENCES users(id),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_company_identity_links_company ON company_identity_links (company_id);

-- Weak resemblances are held for a person, never merged.
CREATE TABLE IF NOT EXISTS company_identity_reviews (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type          text NOT NULL,
  entity_id            text NOT NULL,
  candidate_company_id uuid REFERENCES company_identities(id) ON DELETE CASCADE,
  signals              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','linked','distinct','dismissed')),
  resolved_by          uuid REFERENCES users(id),
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, candidate_company_id)
);

CREATE TABLE IF NOT EXISTS acquisition_journey_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company_identities(id) ON DELETE CASCADE,
  journey        text NOT NULL CHECK (journey IN ('CLAIMED_LISTING','EVENT_PARTNER','SALES_DIRECT')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  reason         text NOT NULL,
  assigned_by    uuid REFERENCES users(id),
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz,
  released_by    uuid REFERENCES users(id),
  release_reason text,
  CONSTRAINT chk_journey_release_complete CHECK (status = 'active' OR (released_at IS NOT NULL AND release_reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_journey ON acquisition_journey_assignments (company_id) WHERE status = 'active';

-- Event Partner screening: a company in the listing journey is never a cold Event Partner prospect.
ALTER TABLE event_partner_eligibility_decisions DROP CONSTRAINT IF EXISTS chk_epe_decision;
ALTER TABLE event_partner_eligibility_decisions ADD CONSTRAINT chk_epe_decision CHECK (decision IN (
  'ELIGIBLE_UNAFFILIATED','EXCLUDE_EVENT_PARTNER','EXCLUDE_CLAIMED_LISTING','EXCLUDE_PRO_SELLER',
  'EXCLUDE_SUPPRESSED','EXCLUDE_RECENT_OUTREACH','EXCLUDE_NO_PUBLIC_CONTACT',
  'REVIEW_AMBIGUOUS_IDENTITY','REVIEW_OTHER_RELATIONSHIP','EXCLUDE_LISTING_JOURNEY'));

ALTER TABLE organization_claim_tokens ADD COLUMN IF NOT EXISTS issue_channel text NOT NULL DEFAULT 'admin';
ALTER TABLE organization_claim_tokens DROP CONSTRAINT IF EXISTS chk_claim_token_issue_channel;
ALTER TABLE organization_claim_tokens ADD CONSTRAINT chk_claim_token_issue_channel
  CHECK (issue_channel IN ('admin','outreach','self_request','resend'));

ALTER TABLE organizations  ADD COLUMN IF NOT EXISTS acquisition jsonb;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS acquisition jsonb;

COMMIT;
