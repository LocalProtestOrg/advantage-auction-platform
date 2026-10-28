-- 207: Professional Seller bulk inventory import with photographs, and a "paused" item status.
-- ADDITIVE / IDEMPOTENT. Moves no money; changes no existing value (every existing item keeps its status; no item is
-- marked as imported).
--   • marketplace_items.status gains 'paused': a published item the seller has taken off sale for now. It is not public
--     (every public surface reads status = 'active'), keeps its details and photos, and can be published again.
--     Its inventory number stays reserved, like draft and active items.
--   • storefront_import_batches: one row per spreadsheet the seller previewed / imported. The validated rows are kept
--     server-side, so the import that is committed is exactly the preview the seller saw (nothing is re-sent).
--   • marketplace_items.import_batch_id / import_row: which import row created an item. Unique per batch row, so a
--     retried or interrupted import never creates the same item twice.
--   • storefront_item_photos: where each uploaded photograph came from (file name, checksum, size). The same photograph
--     (same checksum) is attached to an item at most once, so a retried photo upload never duplicates a photo.
-- Rollback (only before any item is paused or imported):
--   DROP TABLE storefront_item_photos; ALTER TABLE marketplace_items DROP COLUMN import_row, DROP COLUMN import_batch_id;
--   DROP TABLE storefront_import_batches; restore marketplace_items_status_check and uq_marketplace_items_seller_inventory_number
--   from migrations 121 and 204.

ALTER TABLE marketplace_items DROP CONSTRAINT IF EXISTS marketplace_items_status_check;
ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_status_check
  CHECK (status IN ('draft','active','paused','pending_purchase','sold','removed'));

-- Inventory numbers stay unique across the seller's draft, live, paused and in-checkout items (migration 204 + paused).
DROP INDEX IF EXISTS uq_marketplace_items_seller_inventory_number;
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_items_seller_inventory_number
  ON marketplace_items (seller_id, lower(inventory_number))
  WHERE inventory_number IS NOT NULL AND status IN ('draft','active','paused','pending_purchase');

CREATE TABLE IF NOT EXISTS storefront_import_batches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  file_name        TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  file_kind        TEXT NOT NULL CHECK (file_kind IN ('csv','xlsx')),
  file_sha256      TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  status           TEXT NOT NULL DEFAULT 'previewed'
                     CHECK (status IN ('previewed','importing','completed','completed_with_errors','cancelled')),
  mapping          JSONB NOT NULL DEFAULT '{}'::jsonb,
  rows             JSONB NOT NULL DEFAULT '[]'::jsonb,     -- validated rows: [{row, values, errors, warnings, action}]
  total_rows       INTEGER NOT NULL DEFAULT 0,
  ready_rows       INTEGER NOT NULL DEFAULT 0,
  created_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count    INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  results          JSONB NOT NULL DEFAULT '[]'::jsonb,     -- per-row outcome of the import: [{row, outcome, item_id?, code?, message?}]
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_storefront_import_batches_seller ON storefront_import_batches (seller_id, created_at DESC);

ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS import_batch_id UUID REFERENCES storefront_import_batches(id) ON DELETE SET NULL;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS import_row INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_items_import_row
  ON marketplace_items (import_batch_id, import_row) WHERE import_batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS storefront_item_photos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           UUID NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
  seller_id         UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  uploaded_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  url               TEXT NOT NULL CHECK (url ~ '^https://'),
  public_id         TEXT,
  sha256            TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original_filename TEXT CHECK (original_filename IS NULL OR length(original_filename) <= 255),
  bytes             INTEGER CHECK (bytes IS NULL OR bytes >= 0),
  width             INTEGER,
  height            INTEGER,
  source            TEXT NOT NULL CHECK (source IN ('upload','zip')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_storefront_item_photos_seller ON storefront_item_photos (seller_id, created_at DESC);
