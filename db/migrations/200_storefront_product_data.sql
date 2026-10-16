-- 200: Professional Storefront product data for search engines and future shopping feeds (permanent roadmap §4.2,
-- docs/projects/professional-storefront-roadmap.md). ADDITIVE / IDEMPOTENT: new optional columns only, all NULL / empty
-- for existing items; no existing value changes and nothing is published anywhere new by this migration.
--   • brand / manufacturer / gtin / mpn are entered by the seller ONLY when genuinely known. They are never invented or
--     filled in automatically. Antiques, vintage, handmade and one-of-a-kind items normally have none, and are then
--     described as having no product identifiers (derived in code, never entered).
--   • condition_type is the normalized condition used by search engines (new / used / refurbished); the existing free-text
--     `condition` column stays the seller's descriptive grade (e.g. "Excellent vintage condition").
--   • image_alt holds a description for each photo (same order as images), used as the photos' alternative text.

ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS brand           TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS manufacturer    TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS gtin            TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS mpn             TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS condition_type  TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS era_or_period   TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS material        TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS image_alt       JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_condition_type_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_condition_type_check
      CHECK (condition_type IS NULL OR condition_type IN ('new','used','refurbished'));
  END IF;
  -- GTIN-8, UPC-A (12), EAN-13 or GTIN-14 digits only (the check digit is verified by the application).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_gtin_format') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_gtin_format
      CHECK (gtin IS NULL OR gtin ~ '^([0-9]{8}|[0-9]{12,14})$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_product_text_lengths') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_product_text_lengths
      CHECK (coalesce(length(brand), 0) <= 120 AND coalesce(length(manufacturer), 0) <= 120 AND coalesce(length(mpn), 0) <= 70
         AND coalesce(length(era_or_period), 0) <= 120 AND coalesce(length(material), 0) <= 200);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_image_alt_array') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_image_alt_array CHECK (jsonb_typeof(image_alt) = 'array');
  END IF;
END $$;

-- Sitemap / feed scans: public, current items in update order.
CREATE INDEX IF NOT EXISTS idx_marketplace_items_public_updated ON marketplace_items (updated_at DESC) WHERE status IN ('active','pending_purchase','sold');
