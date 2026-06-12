-- Migration: 064_add_auction_archive.sql
-- #22 Admin archive/hide for auctions. Launch-safe alternative to hard delete:
-- hides test auctions from public surfaces while preserving all data
-- (lots, bids, payments, payouts, reports, notifications, audit). No cascade.

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS is_archived    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

-- Public listing queries filter on is_archived; index the common "not archived" path.
CREATE INDEX IF NOT EXISTS idx_auctions_is_archived ON auctions(is_archived) WHERE is_archived = false;
