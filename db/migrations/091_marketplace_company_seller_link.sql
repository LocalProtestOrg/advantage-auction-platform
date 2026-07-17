-- 091: Marketplace Phase 2 — Company (BD directory listing) -> Advantage Seller link.
-- ADDITIVE / NON-BREAKING. Idempotent.
--
-- This is a DEDICATED, purpose-built link that maps a marketplace DISCOVERY listing
-- (organizations.source='bd_import') to the Advantage seller it represents, so the
-- marketplace company card can surface that seller's auctions.
--
-- It is intentionally SEPARATE from seller_profiles.organization_id: that column is the
-- multi-tenant TENANT/partner bridge (it designates which partner an auction/seller belongs
-- to and drives capability resolution). Overwriting it would disturb the tenant system. This
-- new column answers a different question — "which seller does this directory listing
-- represent?" — with zero blast radius on tenancy.
--
-- Admin-confirmed is the SOURCE OF TRUTH for the link (Phase 2). Provenance is captured so a
-- future, configurable auto-linking rule (exact google_place_id, verified domain, or other
-- deterministic identifier) records HOW a link was made without any schema change.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS linked_seller_profile_id UUID REFERENCES seller_profiles(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS linked_seller_at         TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS linked_seller_by         UUID REFERENCES users(id);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS linked_seller_meta       JSONB NOT NULL DEFAULT '{}'::jsonb;  -- { rule, confidence, evidence }

-- Only one directory listing should represent a given seller (a seller maps to at most one
-- public listing). Partial-unique keeps NULLs unconstrained and ignores any historical dupes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_linked_seller
  ON organizations(linked_seller_profile_id)
  WHERE linked_seller_profile_id IS NOT NULL;

COMMENT ON COLUMN organizations.linked_seller_profile_id IS
  'Marketplace Phase 2: the Advantage seller this BD discovery listing represents (admin-confirmed). Separate from seller_profiles.organization_id (multi-tenant bridge). NULL = unlinked.';
COMMENT ON COLUMN organizations.linked_seller_meta IS
  'Provenance of the company->seller link: { rule, confidence, evidence }. rule=admin_confirmed for manual links; a future auto-link rule records its rule key here.';
