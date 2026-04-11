-- Migration: 004_add_unique_payment_constraint.sql
-- Enforces single payment per lot per buyer (DB-level)

-- Add partial unique index: only one non-failed payment per (lot_id, buyer_user_id)
-- This allows multiple failed attempts but prevents duplicate pending/paid
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique_active
  ON payments(lot_id, buyer_user_id)
  WHERE status IN ('pending', 'paid', 'refunded', 'partially_refunded');
