-- 178: Professional Seller default storefront pickup location (owner rule, 2026-09-28).
-- ADDITIVE / IDEMPOTENT. The seller confirms their normal item/pickup location ONCE; storefront items use it automatically
-- unless the seller changes the location for a particular item. PRIVATE: never returned by any public surface (public
-- listings show city/state only). Prefilled from the seller's business details only as a SUGGESTION — it counts only
-- after the seller confirms it (default_pickup_confirmed_at).
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS default_pickup_address_line1 TEXT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS default_pickup_address_line2 TEXT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS default_pickup_city          TEXT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS default_pickup_state         TEXT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS default_pickup_postal_code   TEXT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS default_pickup_country       TEXT NOT NULL DEFAULT 'US';
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS default_pickup_confirmed_at  TIMESTAMPTZ;

-- Where a storefront item's location comes from:
--   'default' = the seller's confirmed default location (marketplace_items.pickup_* stay empty; resolved at sale time)
--   'auction' = copied from the originating auction's pickup address at conversion
--   'item'    = set by the seller for this item only ("Change Location")
UPDATE marketplace_items SET pickup_location_source = 'item' WHERE pickup_location_source = 'seller';
ALTER TABLE marketplace_items DROP CONSTRAINT IF EXISTS marketplace_items_pickup_location_source_check;
ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_pickup_location_source_check
  CHECK (pickup_location_source IS NULL OR pickup_location_source IN ('default','auction','item'));
