-- 122: Alphanumeric (A/B) catalog lot numbers — DISPLAY identity, not the primary key.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Auction houses legitimately insert supplemental lots next to a
-- numbered lot (100, 100A, 100B, 101). We keep the existing INTEGER lot_number as the numeric BASE (100 for
-- 100A) and add lot_number_display for the authoritative catalog string. Deterministic ordering is
-- (lot_number ASC, lot_number_display ASC) — within one base, '100' < '100A' < '100B' lexically. lot_number
-- is display/sort only (no code keys on it by equality), so relaxing its per-auction uniqueness is safe;
-- uniqueness moves to the display string. The lot UUID id remains the immutable identifier everywhere.

ALTER TABLE lots ADD COLUMN IF NOT EXISTS lot_number_display TEXT;

-- Backfill every existing lot so display is always present (plain lots: the integer as text).
UPDATE lots SET lot_number_display = lot_number::text
 WHERE lot_number_display IS NULL AND lot_number IS NOT NULL;

-- Uniqueness now on the catalog string (case-insensitive), per auction. The old integer uniqueness
-- (uq_lots_auction_lot_number) is dropped because A/B lots share an integer base. Existing data already
-- satisfies the new constraint (display = distinct lot_number::text per auction).
ALTER TABLE lots DROP CONSTRAINT IF EXISTS uq_lots_auction_lot_number;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lots_auction_lot_display
  ON lots (auction_id, lower(lot_number_display)) WHERE lot_number_display IS NOT NULL;

-- Catalog-order index (base then display suffix).
CREATE INDEX IF NOT EXISTS idx_lots_auction_catalog_order ON lots (auction_id, lot_number, lot_number_display);
