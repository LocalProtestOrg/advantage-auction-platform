-- 128_lot_category_key.sql — Controlled lot-category foundation. ADDITIVE ONLY.
--
-- Adds a nullable normalized category key alongside the legacy free-text lots.category. Populated going
-- forward (lotService normalizes on create/edit). NO bulk rewrite of historical/imported catalog data:
-- legacy rows keep category_key NULL and consumers fall back to the free-text matcher. Original free-text
-- category is preserved. Idempotent.

ALTER TABLE lots ADD COLUMN IF NOT EXISTS category_key TEXT;

COMMENT ON COLUMN lots.category_key IS
  'Normalized controlled category key (src/constants/lotCategories.js). NULL for legacy/free-text lots; the free-text lots.category is preserved as the source of record.';

CREATE INDEX IF NOT EXISTS idx_lots_category_key ON lots(category_key) WHERE category_key IS NOT NULL;
