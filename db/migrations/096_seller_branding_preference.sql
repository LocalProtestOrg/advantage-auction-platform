-- 096_seller_branding_preference.sql — additive + idempotent.
-- Seller identity visibility policy: private/individual sellers are ALWAYS anonymous to buyers;
-- professional/business sellers MAY display branding, gated by this per-seller preference.
-- Applies only to professional seller_types; private sellers are anonymous regardless of this value.

BEGIN;

ALTER TABLE seller_profiles
  ADD COLUMN IF NOT EXISTS show_branding_to_buyers BOOLEAN NOT NULL DEFAULT true;

COMMIT;
