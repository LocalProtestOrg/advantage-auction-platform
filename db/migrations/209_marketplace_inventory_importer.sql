-- 209: Simple marketplace inventory importer, automatic categories, quantities, photo matching and Post to the Market.
-- ADDITIVE / IDEMPOTENT. Moves no money. No existing row's values change; existing items get the column defaults
-- (quantity 1, category not yet assigned).
--   • Sale Price is the ONE marketplace price, and a DRAFT may have none yet (an imported or posted item the seller has
--     not priced). price_cents becomes nullable; a database rule keeps every item that can be seen or bought priced:
--     only 'draft' and 'removed' items may be unpriced.
--   • quantity (how many the seller has, default 1), dimensions and color: seller-provided product facts.
--   • Categories (the ONE taxonomy, src/constants/lotCategories.js): category_key + where it came from
--     (category_source: spreadsheet | automatic | seller | auction), the classifier's confidence, and whether it is
--     still pending. A seller's own choice (source 'seller') is never overwritten by automatic processing (enforced in
--     code and pinned by tests). category_input keeps the spreadsheet's original text.
--   • source_lot_number: the original auction lot number, an INTERNAL import reference (photo matching, Post to the
--     Market provenance); never shown publicly.
--   • storefront_import_mappings: a seller's approved column choices per source software (header fingerprint), so the
--     next import of the same export needs no mapping.
--   • storefront_import_batches: the photo-matching reference, the duplicate-handling choice and the mapping version.
--   • storefront_import_photos: photos staged for one import (uploaded or fetched from a permitted link), matched to a
--     spreadsheet row, ordered, and attached when the row's draft is created. Unique per batch and checksum.
--   • storefront_item_photos.source gains 'url' (fetched from a link in the spreadsheet) and 'auction' (Post to the
--     Market reuses the lot's photos).
-- Rollback (only before any item is saved without a price, with a quantity other than 1, or categorised):
--   ALTER TABLE marketplace_items DROP CONSTRAINT marketplace_items_priced_when_visible; ALTER TABLE marketplace_items
--   ALTER COLUMN price_cents SET NOT NULL; ALTER TABLE marketplace_items DROP COLUMN quantity, DROP COLUMN dimensions,
--   DROP COLUMN color, DROP COLUMN category_key, DROP COLUMN category_source, DROP COLUMN category_confidence,
--   DROP COLUMN category_status, DROP COLUMN category_input, DROP COLUMN category_updated_at, DROP COLUMN source_lot_number;
--   DROP TABLE storefront_import_photos; DROP TABLE storefront_import_mappings; ALTER TABLE storefront_import_batches
--   DROP COLUMN photo_match, DROP COLUMN duplicate_mode, DROP COLUMN mapping_version; restore
--   storefront_item_photos_source_check from 207.

-- ── Sale Price: required whenever an item can be seen or bought ──────────────────────────────────────────────────
ALTER TABLE marketplace_items ALTER COLUMN price_cents DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_priced_when_visible') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_priced_when_visible
      CHECK (status IN ('draft','removed') OR (price_cents IS NOT NULL AND price_cents > 0));
  END IF;
END $$;

-- ── Product facts and quantity ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS quantity   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS dimensions TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS color      TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_quantity_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_quantity_check CHECK (quantity >= 0 AND quantity <= 100000);
  END IF;
END $$;

-- ── Categories ───────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS category_key        TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS category_source     TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS category_confidence NUMERIC(4,3);
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS category_status     TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS category_input      TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS category_updated_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_category_source_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_category_source_check
      CHECK (category_source IS NULL OR category_source IN ('spreadsheet','automatic','seller','auction'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_category_status_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_category_status_check
      CHECK (category_status IS NULL OR category_status IN ('assigned','pending'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_category_confidence_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_category_confidence_check
      CHECK (category_confidence IS NULL OR (category_confidence >= 0 AND category_confidence <= 1));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_marketplace_items_category_pending
  ON marketplace_items (seller_id) WHERE category_status = 'pending';

-- ── Import references ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS source_lot_number TEXT;

CREATE TABLE IF NOT EXISTS storefront_import_mappings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  signature     TEXT NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),   -- fingerprint of the normalized header row
  source_label  TEXT CHECK (source_label IS NULL OR length(source_label) <= 80),   -- e.g. "AuctionFlex export"
  headers       JSONB NOT NULL DEFAULT '[]'::jsonb,
  columns       JSONB NOT NULL DEFAULT '[]'::jsonb,                    -- destination per column, in column order
  photo_match   JSONB NOT NULL DEFAULT '{}'::jsonb,
  use_count     INTEGER NOT NULL DEFAULT 1,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (seller_id, signature)
);

ALTER TABLE storefront_import_batches ADD COLUMN IF NOT EXISTS photo_match     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE storefront_import_batches ADD COLUMN IF NOT EXISTS duplicate_mode  TEXT NOT NULL DEFAULT 'skip';
ALTER TABLE storefront_import_batches ADD COLUMN IF NOT EXISTS mapping_version INTEGER NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_import_batches_duplicate_mode_check') THEN
    ALTER TABLE storefront_import_batches ADD CONSTRAINT storefront_import_batches_duplicate_mode_check
      CHECK (duplicate_mode IN ('skip','update_drafts'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS storefront_import_photos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL REFERENCES storefront_import_batches(id) ON DELETE CASCADE,
  seller_id         UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  uploaded_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  row_number        INTEGER,                                   -- the spreadsheet row this photo belongs to
  position          INTEGER NOT NULL DEFAULT 0,                -- order within the row's photos (0 = primary)
  url               TEXT NOT NULL CHECK (url ~ '^https://'),
  public_id         TEXT,
  sha256            TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original_filename TEXT CHECK (original_filename IS NULL OR length(original_filename) <= 255),
  source            TEXT NOT NULL CHECK (source IN ('upload','zip','url')),
  source_url        TEXT CHECK (source_url IS NULL OR length(source_url) <= 2000),
  bytes             INTEGER CHECK (bytes IS NULL OR bytes >= 0),
  width             INTEGER,
  height            INTEGER,
  status            TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','attached','discarded')),
  item_id           UUID REFERENCES marketplace_items(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_storefront_import_photos_batch ON storefront_import_photos (batch_id, row_number, position);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_item_photos_source_check') THEN
    ALTER TABLE storefront_item_photos DROP CONSTRAINT storefront_item_photos_source_check;
  END IF;
  ALTER TABLE storefront_item_photos ADD CONSTRAINT storefront_item_photos_source_check
    CHECK (source IN ('upload','zip','url','auction'));
END $$;
