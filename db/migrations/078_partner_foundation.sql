-- 078: Partner Foundation (Phase 2) — makes the platform truly multi-tenant. ADDITIVE / NON-BREAKING.
-- Builds on 077 (Organization = Partner). Four pillars:
--   A) Capability enforcement — plan→capability mapping + grants for all orgs.
--   B) Organization configuration — platform defaults → partner overrides (config hierarchy §9).
--   C) Legal document framework — per-tenant, versioned, with an acceptance ledger (§8 legal).
--   D) Marketplace syndication — default-on + admin-only visibility controls (§7).
-- No payments/Stripe/settlement/tax ENGINE changes (business-rule values are stored as config only).
-- Idempotent: IF NOT EXISTS + ON CONFLICT DO NOTHING.

-- ============ A) Capability enforcement =======================================
CREATE TABLE IF NOT EXISTS plan_capabilities (
  plan_tier  TEXT NOT NULL REFERENCES organization_plans(plan_tier) ON DELETE CASCADE,
  capability TEXT NOT NULL REFERENCES capabilities(key) ON DELETE CASCADE,
  PRIMARY KEY (plan_tier, capability)
);
INSERT INTO plan_capabilities (plan_tier, capability) VALUES
  ('free','organizations'),('free','events'),('free','widgets'),
  ('standard','organizations'),('standard','events'),('standard','widgets'),('standard','imports'),('standard','shipping'),
  ('premium','organizations'),('premium','events'),('premium','widgets'),('premium','imports'),('premium','shipping'),
  ('premium','api'),('premium','reporting'),('premium','ai'),('premium','live_auctions')
ON CONFLICT DO NOTHING;

-- Grant plan-based capabilities to all existing NON-platform organizations (platform tenant already has all).
INSERT INTO organization_capabilities (organization_id, capability, source)
SELECT o.id, pc.capability, 'plan'
  FROM organizations o
  JOIN plan_capabilities pc ON pc.plan_tier = o.plan_tier
 WHERE o.is_platform_tenant = false
ON CONFLICT (organization_id, capability) DO NOTHING;

-- ============ B) Organization configuration ===================================
CREATE TABLE IF NOT EXISTS platform_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general',
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_config (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value           JSONB NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID REFERENCES users(id),
  PRIMARY KEY (organization_id, key)
);
-- Platform default config: branding + business-rule VALUES as data (config only; NOT wired to settlement).
INSERT INTO platform_config (key, value, category, description) VALUES
  ('branding.site_name',           '"Advantage.Bid"', 'branding', 'Display name'),
  ('branding.primary_color',       '"#B5273B"',       'branding', 'Primary brand color'),
  ('branding.accent_color',        '"#2F6BFF"',       'branding', 'Accent color'),
  ('branding.logo_url',            'null',            'branding', 'Logo URL (null = platform default)'),
  ('branding.font',                '"Fraunces"',      'branding', 'Display font'),
  ('business.buyer_premium_pct',   '0',               'business', 'Buyer premium % (config only; not yet enforced by settlement)'),
  ('business.seller_commission_pct','0',              'business', 'Seller commission % (config only; not yet enforced)'),
  ('business.platform_fee_pct',    '0',               'business', 'Platform fee % (config only; not yet enforced)')
ON CONFLICT (key) DO NOTHING;

-- ============ C) Legal document framework =====================================
CREATE TABLE IF NOT EXISTS legal_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,   -- NULL = platform-level default
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('buyer_terms','seller_agreement','privacy_policy','refund_policy','pickup_policy')),
  title           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, doc_type)
);
CREATE TABLE IF NOT EXISTS legal_document_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
  version      INT NOT NULL,
  content      TEXT NOT NULL,
  is_published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_version_id UUID NOT NULL REFERENCES legal_document_versions(id) ON DELETE CASCADE,
  organization_id     UUID REFERENCES organizations(id) ON DELETE SET NULL,
  accepted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip                  TEXT,
  UNIQUE (user_id, document_version_id)
);
CREATE INDEX IF NOT EXISTS idx_legal_docs_org        ON legal_documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_legal_versions_doc    ON legal_document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_usr ON legal_acceptances(user_id);

-- ============ D) Marketplace syndication ======================================
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS is_syndicated          BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS marketplace_status     TEXT NOT NULL DEFAULT 'syndicated'
                                                CHECK (marketplace_status IN ('syndicated','hidden','removed'));
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS is_featured            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS is_promoted            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS marketplace_updated_at TIMESTAMPTZ;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS marketplace_updated_by UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_auctions_marketplace_syndicated ON auctions(marketplace_status) WHERE marketplace_status = 'syndicated';
CREATE INDEX IF NOT EXISTS idx_auctions_featured ON auctions(is_featured) WHERE is_featured = true;
