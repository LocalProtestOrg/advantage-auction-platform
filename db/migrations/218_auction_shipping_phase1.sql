-- 218_auction_shipping_phase1.sql - Auction shipping, Phase 1 (spec docs/projects/auction-shipping-spec.md; owner policy
-- 2026-11-04/05). Additive only: new columns default to "no shipping", one new empty table. Changes no existing row's
-- behavior. Everything it adds is read only while AUCTION_SHIPPING_ENABLED=true (off by default).
--
--   • seller_shipping_profiles: a seller's reusable shipping settings (flat rate or quote required, handling days, domestic
--     destinations with excluded states, packaging note). One default per seller. Archived, never deleted, so a lot that
--     used a profile keeps its record.
--   • lots.shipping_eligible (default false): a lot ships ONLY when explicitly marked. lots.shipping_profile_id,
--     lots.shipping_restriction (text shown to buyers), lots.shipping_quote_required. The legacy lots.shippable and
--     auctions.shipping_available columns are not changed by this migration.
--   • seller_profiles shipping approval for Individual Sellers (approved_at/by, reason; the existing admin-set
--     capabilities.shipping_enabled stays the on/off gate), the per-shipment limit (NULL = the $500 default), and the
--     seller's one-time payout and fraud education acknowledgment.
-- Shipments, tracking, signature and payout-hold tables are Phase 3 (the constants and release-date rule live in
-- src/lib/auctionShippingPolicy.js now).
-- Reverse: ALTER TABLE lots DROP COLUMN shipping_eligible, DROP COLUMN shipping_profile_id, DROP COLUMN shipping_restriction,
--          DROP COLUMN shipping_quote_required;
--          ALTER TABLE seller_profiles DROP COLUMN shipping_approved_at, DROP COLUMN shipping_approved_by,
--          DROP COLUMN shipping_approval_reason, DROP COLUMN shipping_per_shipment_limit_cents,
--          DROP COLUMN shipping_education_acknowledged_at, DROP COLUMN shipping_education_version;
--          DROP TABLE seller_shipping_profiles;

CREATE TABLE IF NOT EXISTS seller_shipping_profiles (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_profile_id  UUID NOT NULL REFERENCES seller_profiles(id),
  name               TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  method             TEXT NOT NULL DEFAULT 'quote_required' CHECK (method IN ('flat_rate', 'quote_required')),
  flat_rate_cents    INTEGER CHECK (flat_rate_cents IS NULL OR flat_rate_cents BETWEEN 0 AND 1000000),
  handling_days      INTEGER NOT NULL DEFAULT 3 CHECK (handling_days BETWEEN 1 AND 30),
  destinations       TEXT NOT NULL DEFAULT 'domestic_us' CHECK (destinations IN ('domestic_us')),
  excluded_states    TEXT[] NOT NULL DEFAULT '{}',
  packaging_note     TEXT CHECK (packaging_note IS NULL OR length(packaging_note) <= 500),
  is_default         BOOLEAN NOT NULL DEFAULT false,
  archived_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A flat-rate profile always states its rate; a quote-required profile never carries one.
  CONSTRAINT seller_shipping_profiles_rate_matches_method CHECK (
    (method = 'flat_rate' AND flat_rate_cents IS NOT NULL) OR (method = 'quote_required' AND flat_rate_cents IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_seller_shipping_profiles_seller ON seller_shipping_profiles (seller_profile_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_shipping_profiles_one_default ON seller_shipping_profiles (seller_profile_id)
  WHERE is_default AND archived_at IS NULL;

ALTER TABLE lots ADD COLUMN IF NOT EXISTS shipping_eligible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS shipping_profile_id UUID REFERENCES seller_shipping_profiles(id);
ALTER TABLE lots ADD COLUMN IF NOT EXISTS shipping_restriction TEXT;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS shipping_quote_required BOOLEAN NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_shipping_restriction_length') THEN
    ALTER TABLE lots ADD CONSTRAINT lots_shipping_restriction_length CHECK (shipping_restriction IS NULL OR length(shipping_restriction) <= 300);
  END IF;
  -- An eligible lot always names the shipping settings it uses.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_shipping_eligible_has_profile') THEN
    ALTER TABLE lots ADD CONSTRAINT lots_shipping_eligible_has_profile CHECK (shipping_eligible IS NOT TRUE OR shipping_profile_id IS NOT NULL);
  END IF;
END $$;

ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS shipping_approved_at TIMESTAMPTZ;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS shipping_approved_by UUID REFERENCES users(id);
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS shipping_approval_reason TEXT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS shipping_per_shipment_limit_cents INTEGER;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS shipping_education_acknowledged_at TIMESTAMPTZ;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS shipping_education_version TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_profiles_shipping_limit_positive') THEN
    ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_shipping_limit_positive
      CHECK (shipping_per_shipment_limit_cents IS NULL OR shipping_per_shipment_limit_cents BETWEEN 100 AND 100000000);
  END IF;
END $$;
