-- Migration: 035_add_enhancement_enabled_to_lot_images.sql
-- Persists the AI background removal preference per image row.
-- Defaults to true so existing rows retain enhancement behavior.

ALTER TABLE lot_images
  ADD COLUMN IF NOT EXISTS enhancement_enabled BOOLEAN NOT NULL DEFAULT true;
