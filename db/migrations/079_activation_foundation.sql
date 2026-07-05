-- 079: Activation Foundation (Phase 3A) — Organization lifecycle, ownership consolidation,
-- BD linkage + dedup key. ADDITIVE / NON-BREAKING. No column removals (deprecations via COMMENT).
-- Builds on 077/078. No Stripe/settlement/payment/tax. Idempotent.

-- 1) Lifecycle + provenance + BD linkage + dedup key ─────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'inactive'
  CHECK (lifecycle_state IN ('prospect','directory_listing','inactive','claimed','verified',
                             'active_partner','white_label_partner','enterprise_partner','partner_ambassador'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'onboarding'
  CHECK (source IN ('onboarding','direct_signup','bd_import','directory_claim','admin'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bd_listing_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS match_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_bd_listing ON organizations(bd_listing_id) WHERE bd_listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_lifecycle ON organizations(lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_organizations_match_key ON organizations(match_key) WHERE match_key IS NOT NULL;

-- 2) Ownership consolidation — formal deprecations (non-destructive) ──────────
COMMENT ON COLUMN organizations.seller_profile_id IS
  'DEPRECATED 2026-07-05 (Phase 3A): canonical auction owner is auctions.organization_id; the org<->seller bridge is seller_profiles.organization_id. Do not use.';
COMMENT ON COLUMN seller_profiles.capabilities IS
  'DEPRECATED 2026-07-05 (Phase 3A): superseded by organization_capabilities. Do not read/write.';
COMMENT ON COLUMN auctions.organization_id IS
  'CANONICAL auction owner (Phase 3A). seller_profiles.organization_id is the legacy bridge.';

-- 3) Backfill existing organizations (real, operating orgs → active_partner) ──
UPDATE organizations
   SET lifecycle_state = 'active_partner'
 WHERE lifecycle_state = 'inactive';                                   -- only the just-added default rows
UPDATE organizations SET source = 'admin' WHERE is_platform_tenant = true;
UPDATE organizations
   SET match_key = lower(regexp_replace(coalesce(name,''), '[^A-Za-z0-9]+', '', 'g')) || ':' || lower(btrim(coalesce(state,'')))
 WHERE match_key IS NULL;
