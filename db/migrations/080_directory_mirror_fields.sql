-- 080: Directory Mirror fields (Phase 3B) — first-class fields for BD-mirrored Organizations.
-- ADDITIVE / NON-BREAKING. Builds on 079. No Stripe/settlement/payment/tax. Idempotent.
--
-- google_place_id promoted to a FIRST-CLASS Organization field (strongest long-term business
-- identifier; used for dedup + verification). description/lat/lng promoted for UI + discovery.
-- bd_metadata JSONB holds the remaining raw BD provenance (profession_id, subscription hint, etc.).
-- NOTE: logo_url is intentionally NOT populated on import (logos deferred until claim/permission).

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lat             NUMERIC(9,6);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lng             NUMERIC(9,6);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS google_place_id TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bd_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Index for dedup/verification matching (non-unique: BD data may contain duplicates; the import
-- service enforces dedup. Can be tightened to UNIQUE once data quality is proven).
CREATE INDEX IF NOT EXISTS idx_organizations_google_place ON organizations(google_place_id) WHERE google_place_id IS NOT NULL;

COMMENT ON COLUMN organizations.google_place_id IS 'Google Place ID — first-class business identifier (Phase 3B); primary high-confidence dedup/verification key.';
COMMENT ON COLUMN organizations.bd_metadata IS 'Raw BD provenance for mirrored listings (profession_id, subscription hint, source fields). Non-authoritative once claimed.';
