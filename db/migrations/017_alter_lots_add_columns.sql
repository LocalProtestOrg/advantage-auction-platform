-- Migration: 017_alter_lots_add_columns.sql
-- Adds category, integer bid columns, and status default to existing lots table.
-- Does NOT remove load-bearing columns (winning_buyer_user_id, winning_amount_cents, position, etc.)

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS starting_bid_cents INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_bid_cents INTEGER DEFAULT 0;

ALTER TABLE lots
  ALTER COLUMN status SET DEFAULT 'draft';
