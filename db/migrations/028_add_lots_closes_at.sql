-- Migration: 028_add_lots_closes_at.sql
-- Adds per-lot closing timestamp required for the soft-close and anti-snipe features.
-- NULL means the lot has no scheduled close time (closes manually).

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS closes_at TIMESTAMPTZ;
