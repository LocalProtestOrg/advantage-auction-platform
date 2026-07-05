-- 077: Tenant Foundation — Organization = Partner + capability model (Phase 1: Platform Foundation).
--
-- ADDITIVE / NON-BREAKING. Establishes the multi-tenant spine per the Project Constitution:
--   • Organizations become the tenant/Partner root (is_platform_tenant + reserved white-label cols).  [§5]
--   • Capability catalog + per-organization capability grants (plans grant capabilities;
--     capabilities drive authorization + future billing).                                             [§11]
--   • Nullable organization_id tenant key on the LIVE auction ownership chain
--     (seller_profiles, auctions). The live auction system is `auctions` (seller-owned);
--     app_auctions/app_bids are legacy demo scaffolding and are intentionally untouched.              [§5]
--   • Advantage Auction Company seeded as Organization / Partner #1 (the platform tenant),
--     granted ALL capabilities.                                                                        [§2]
--   • Backfill: all existing sellers + auctions belong to Advantage (Partner #1). Idempotent.
--
-- NO changes to payments/Stripe/settlement/tax. NO behavior change: nothing reads organization_id or
-- capabilities on the auction path yet; the read-layer helpers (tenantContext, requireCapability) are
-- added but NOT wired to existing routes. Idempotent: IF NOT EXISTS + ON CONFLICT + guarded seed/backfill.

-- 1) Organizations as tenant root ─────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_platform_tenant BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS primary_domain    TEXT;                            -- reserved: white-label host
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS custom_domains    JSONB NOT NULL DEFAULT '[]'::JSONB; -- reserved
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_primary_domain  ON organizations(primary_domain) WHERE primary_domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_platform_tenant ON organizations(is_platform_tenant) WHERE is_platform_tenant = TRUE;

-- 2) Capability catalog ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS capabilities (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO capabilities (key, name, description, sort_order) VALUES
  ('auctions',       'Auctions',       'Create and run auctions',              10),
  ('events',         'Events',         'Create and publish local events',      20),
  ('organizations',  'Organizations',  'Organization/partner management',      30),
  ('imports',        'Imports',        'Import external/third-party listings',  40),
  ('shipping',       'Shipping',       'Shipping options and fulfillment',      50),
  ('white_label',    'White-Label',    'Custom domain and branding',            60),
  ('widgets',        'Widgets',        'Embeddable marketplace widgets',        70),
  ('api',            'API',            'Partner API access',                    80),
  ('live_auctions',  'Live Auctions',  'Real-time live auction events',         90),
  ('ai',             'AI',             'AI assistance and automation',         100),
  ('reporting',      'Reporting',      'Analytics and reporting',              110),
  ('custom_domains', 'Custom Domains', 'Bring-your-own domain',                120)
ON CONFLICT (key) DO NOTHING;

-- 3) Per-organization capability grants (effective; source = plan | grant | override) ─
CREATE TABLE IF NOT EXISTS organization_capabilities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  capability      TEXT NOT NULL REFERENCES capabilities(key),
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  source          TEXT NOT NULL DEFAULT 'grant' CHECK (source IN ('plan','grant','override')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_org_capabilities_org ON organization_capabilities(organization_id);

-- 4) Tenant key on the live auction ownership chain (nullable, additive) ───────
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE auctions        ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_seller_profiles_org ON seller_profiles(organization_id);
CREATE INDEX IF NOT EXISTS idx_auctions_org        ON auctions(organization_id);

-- 5) Seed Advantage Auction Company as Organization / Partner #1 (platform tenant) ─
INSERT INTO organizations (slug, name, type, status, plan_tier, verification_status, verified_at, contact_email, is_platform_tenant)
SELECT 'advantage-auction-company', 'Advantage Auction Company', 'auction_company', 'active', 'premium', 'verified', now(), 'admin@advantage.bid', TRUE
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE is_platform_tenant = TRUE);

-- 6) Grant ALL capabilities to the platform tenant ────────────────────────────
INSERT INTO organization_capabilities (organization_id, capability, source)
SELECT o.id, c.key, 'plan'
  FROM organizations o CROSS JOIN capabilities c
 WHERE o.is_platform_tenant = TRUE
ON CONFLICT (organization_id, capability) DO NOTHING;

-- 7) Backfill: existing sellers + auctions belong to Advantage (Partner #1). Idempotent. ─
UPDATE seller_profiles
   SET organization_id = (SELECT id FROM organizations WHERE is_platform_tenant = TRUE LIMIT 1)
 WHERE organization_id IS NULL;
UPDATE auctions
   SET organization_id = (SELECT id FROM organizations WHERE is_platform_tenant = TRUE LIMIT 1)
 WHERE organization_id IS NULL;
