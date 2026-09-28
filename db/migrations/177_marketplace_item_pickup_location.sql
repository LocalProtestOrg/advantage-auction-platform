-- 177: Storefront item pickup location — the actual place a buyer takes possession of a storefront item.
-- ADDITIVE / IDEMPOTENT. Used for sales tax (the sale location for pickup; the origin for shipping) and, after payment,
-- for the buyer's pickup instructions. NEVER exposed on public pages (city/state remain the public location).
--
-- Source hierarchy (owner rule, 2026-09-28):
--   converted from an auction lot → the originating auction's pickup address (copied here), unless the seller changes it;
--   created directly by the seller → the pickup location the seller enters.
-- The seller's legal/agreement address and Advantage.Bid's own address are never used as an item's pickup location.
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pickup_address_line1   TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pickup_address_line2   TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pickup_city            TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pickup_state           TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pickup_postal_code     TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pickup_country         TEXT NOT NULL DEFAULT 'US';
-- 'auction' = inherited from the originating auction; 'seller' = entered or changed by the seller.
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pickup_location_source TEXT;
ALTER TABLE marketplace_items DROP CONSTRAINT IF EXISTS marketplace_items_pickup_location_source_check;
ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_pickup_location_source_check
  CHECK (pickup_location_source IS NULL OR pickup_location_source IN ('auction','seller'));
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS pickup_location_updated_at TIMESTAMPTZ;

-- Existing items converted from an auction inherit that auction's pickup address (only where it has one; never guessed).
UPDATE marketplace_items mi
   SET pickup_address_line1 = btrim(a.street_address),
       pickup_city          = btrim(a.city),
       pickup_state         = upper(btrim(a.address_state)),
       pickup_postal_code   = btrim(a.zip),
       pickup_country       = 'US',
       pickup_location_source = 'auction',
       pickup_location_updated_at = now()
  FROM auctions a
 WHERE a.id = mi.source_auction_id
   AND mi.pickup_address_line1 IS NULL
   AND nullif(btrim(a.street_address), '') IS NOT NULL
   AND nullif(btrim(a.city), '') IS NOT NULL
   AND nullif(btrim(a.address_state), '') IS NOT NULL
   AND nullif(btrim(a.zip), '') IS NOT NULL;
