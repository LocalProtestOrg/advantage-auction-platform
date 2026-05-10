-- Migration: 037_add_lot_item_details.sql
-- Adds item-level descriptive metadata to lots.
-- All columns nullable; existing rows are unaffected.

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS condition TEXT,
  ADD COLUMN IF NOT EXISTS material TEXT,
  ADD COLUMN IF NOT EXISTS era TEXT,
  ADD COLUMN IF NOT EXISTS maker_artist TEXT,
  ADD COLUMN IF NOT EXISTS weight TEXT;
