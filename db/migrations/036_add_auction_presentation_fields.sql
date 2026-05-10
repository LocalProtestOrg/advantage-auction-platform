-- Migration: 036_add_auction_presentation_fields.sql
-- Adds auction-level media and scheduling fields.
-- Walkthrough videos are in their own table (see 038_create_auction_walkthrough_videos.sql).
-- All columns are optional (nullable) or have safe defaults so existing rows are unaffected.

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS subtitle TEXT,
  ADD COLUMN IF NOT EXISTS street_address TEXT,
  ADD COLUMN IF NOT EXISTS banner_image_url TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS preview_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preview_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shipping_available BOOLEAN NOT NULL DEFAULT false;
