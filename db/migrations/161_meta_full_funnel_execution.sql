-- 161_meta_full_funnel_execution.sql — ADDITIVE + idempotent.
--
-- The runtime could create a Meta CAMPAIGN and nothing else. A campaign is an empty container: it
-- carries an objective and a spend cap, but geography lives on the AD SET, and the destination URL,
-- the approved image and the words live on the AD CREATIVE. Without those, an authorized plan
-- cannot be transmitted to the provider at all, let alone verified against it.
--
-- This adds the three things the delivery chain needs:
--
--   1. GOVERNED CREATIVE PACKAGES. The production registry governs IMAGES. A deployable Meta ad also
--      needs primary text, a headline, a call to action and a destination — and those must be
--      governed too, or the words that actually run become whatever the last caller passed in.
--      A package is approved as a unit and fingerprinted, so a changed word is a changed package.
--
--   2. PROVIDER IMAGE REUSE. An uploaded image is identified by the provider's own hash. Keyed by
--      the governed asset's sha256 so the same approved file is never uploaded twice, and so an
--      upload can never be attributed to a file the registry does not govern.
--
--   3. PROVIDER OBJECT LEDGER. Every campaign, ad set, creative and ad we create, with its parent
--      relationship and a UNIQUE idempotency key, so a retry or a restart reconciles against what
--      already exists at Meta instead of creating a second one.
--
-- Nothing here enables delivery. Every provider object is created PAUSED and `intended_status`
-- records what it is ALLOWED to be, which is never ACTIVE without a separate Owner decision.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Governed creative packages — the words, not only the picture.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_creative_packages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_key         text        NOT NULL UNIQUE,
  production_creative_id uuid     NOT NULL REFERENCES marketing_production_creative(id) ON DELETE RESTRICT,
  funnel              text        NOT NULL,
  audience_purpose    text,
  -- The deployable copy. Provider limits are enforced in the service, not guessed at here.
  primary_text        text        NOT NULL,
  headline            text        NOT NULL,
  description         text,
  cta_type            text        NOT NULL DEFAULT 'LEARN_MORE',
  destination_url     text        NOT NULL,
  attribution_template jsonb      NOT NULL DEFAULT '{}'::jsonb,
  -- Governance. A package is approved as a whole; changing a word changes the fingerprint.
  version             integer     NOT NULL DEFAULT 1,
  fingerprint         text        NOT NULL,
  approval_state      text        NOT NULL DEFAULT 'DRAFT',
  policy_status       text        NOT NULL DEFAULT 'OK',
  policy_detail       text,
  provenance          text,
  active              boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mcp_funnel CHECK (funnel IN ('buyer','individual_seller','professional_seller')),
  CONSTRAINT chk_mcp_approval CHECK (approval_state IN ('DRAFT','OWNER_APPROVED','REJECTED','SUPERSEDED')),
  CONSTRAINT chk_mcp_policy CHECK (policy_status IN ('OK','BLOCKED')),
  -- Only an Owner-approved, policy-clean package may be active.
  CONSTRAINT chk_mcp_active_requires_approval CHECK (
    active = false OR (approval_state = 'OWNER_APPROVED' AND policy_status = 'OK')),
  -- A paid destination must be a canonical Advantage.Bid URL.
  CONSTRAINT chk_mcp_destination CHECK (destination_url LIKE 'https://bid.advantage.bid/%'
                                     OR destination_url LIKE 'https://www.advantage.bid/%')
);
CREATE INDEX IF NOT EXISTS idx_mcp_funnel ON marketing_creative_packages(funnel);

-- ---------------------------------------------------------------------------------------------
-- 2. Provider image uploads, keyed by the governed asset's own fingerprint.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_provider_images (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text        NOT NULL DEFAULT 'meta',
  account_ref         text        NOT NULL,
  production_creative_id uuid     NOT NULL REFERENCES marketing_production_creative(id) ON DELETE RESTRICT,
  asset_sha256        text        NOT NULL,
  provider_image_hash text        NOT NULL,
  provider_url        text,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  -- The same governed asset is uploaded once per account and reused thereafter.
  UNIQUE (provider, account_ref, asset_sha256)
);

-- ---------------------------------------------------------------------------------------------
-- 3. Provider object ledger — what we created, under what parent, and how to find it again.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_provider_objects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text        NOT NULL DEFAULT 'meta',
  account_ref         text        NOT NULL,
  object_type         text        NOT NULL,
  provider_id         text,
  parent_provider_id  text,
  campaign_key        text        REFERENCES marketing_paid_campaigns(campaign_key) ON DELETE CASCADE,
  experiment_arm_id   uuid        REFERENCES marketing_audience_experiment_arms(id) ON DELETE SET NULL,
  package_key         text,
  -- A retry re-uses this key and reconciles instead of creating a second provider object.
  idempotency_key     text        NOT NULL UNIQUE,
  -- What it IS at the provider, and what it is ALLOWED to be. Build mode never intends ACTIVE.
  provider_status     text,
  intended_status     text        NOT NULL DEFAULT 'PAUSED',
  certification_artifact boolean  NOT NULL DEFAULT false,
  last_error          text,
  evidence            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_reconciled_at  timestamptz,
  CONSTRAINT chk_mpo_type CHECK (object_type IN ('campaign','adset','adcreative','ad','adimage')),
  CONSTRAINT chk_mpo_intended CHECK (intended_status IN ('PAUSED','ACTIVE','ARCHIVED','DELETED'))
);
CREATE INDEX IF NOT EXISTS idx_mpo_campaign ON marketing_provider_objects(campaign_key);
CREATE INDEX IF NOT EXISTS idx_mpo_type ON marketing_provider_objects(object_type);
CREATE INDEX IF NOT EXISTS idx_mpo_provider_id ON marketing_provider_objects(provider_id);

-- ---------------------------------------------------------------------------------------------
-- 4. Config. Nothing is switched on; no authority is added.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform_config (key, value, category) VALUES
  -- Build mode: objects may be created for certification but may never be set ACTIVE.
  ('marketing.paid.build_mode', 'true', 'marketing'),
  -- The identities a Meta ad must be published as. Verified assets only.
  ('marketing.meta.page_id', '"449143945236360"', 'marketing'),
  ('marketing.meta.instagram_id', '"17841436199617514"', 'marketing'),
  ('marketing.meta.pixel_id', '"2041842543203121"', 'marketing')
ON CONFLICT (key) DO NOTHING;

COMMIT;
