-- SELLER-TYPE RULES FRAMEWORK — Phase B: expand seller_type + default to private.
--
-- Background: seller_profiles.seller_type was CHECK (IN ('business','private',
-- 'other')) from migration 001 (inline, so Postgres auto-named the constraint).
-- The Seller-Type Rules Framework introduces three PROFESSIONAL seller types
-- that will (in a later phase) be exempt from the non-professional 48-hour
-- pickup-gap rule. This migration only widens the allowed set and sets the
-- default — it does NOT add any validation/enforcement (that is Phase C).
--
-- Two changes, both additive and backward-compatible:
--   1. Widen the seller_type CHECK to include the three professional types.
--   2. Default new rows to 'private' (decision Q2). There is no application-
--      level seller_profiles creation path today (only seed scripts insert
--      profiles), so the DB column DEFAULT is the correct home for the rule —
--      it covers every future insert (seed or a future onboarding flow).
--
-- Existing rows ('business' / 'private' / 'other' / NULL) remain valid and are
-- NOT rewritten. NULL continues to behave as non-professional (== private) in
-- the Phase C classifier. The legacy 'business' edit-bypass in lots.js is
-- untouched. No data backfill.
--
-- Constraint rename note: migration 001 did not pin a stable constraint name,
-- so we discover the inferred name dynamically (same pattern as migration 049
-- for auctions.state), drop it, then add a stably-named widened constraint.
-- Idempotent: re-running drops the (now stably-named) constraint and re-adds
-- it; SET DEFAULT is naturally idempotent.
--
-- Rollback (manual — this repo uses forward-only migrations, no .down.sql):
--   ALTER TABLE seller_profiles ALTER COLUMN seller_type DROP DEFAULT;
--   ALTER TABLE seller_profiles DROP CONSTRAINT IF EXISTS seller_profiles_seller_type_check;
--   ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_seller_type_check
--     CHECK (seller_type IN ('business','private','other'));
--   NOTE: the rollback CHECK will fail if any row already holds a professional
--   type — re-type those sellers to a legacy value first.

-- 1. Replace the inferred CHECK with a widened, stably-named one.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'seller_profiles'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%seller_type%IN%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE seller_profiles DROP CONSTRAINT %I', cname);
  END IF;
END$$;

ALTER TABLE seller_profiles
  DROP CONSTRAINT IF EXISTS seller_profiles_seller_type_check;

ALTER TABLE seller_profiles
  ADD CONSTRAINT seller_profiles_seller_type_check
  CHECK (seller_type IN (
    'business','private','other',
    'auction_house','estate_sale_company','professional_liquidator'
  ));

-- 2. Default new rows to 'private' (decision Q2). Future inserts only;
--    existing rows are untouched.
ALTER TABLE seller_profiles
  ALTER COLUMN seller_type SET DEFAULT 'private';
