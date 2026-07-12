-- Migration: 088_settlement_ops.sql
-- Increment 4 (Settlement Operations). ADDITIVE ONLY.
--
-- Payment-reconciliation fields already exist on seller_payouts and are REUSED, not
-- duplicated: payout_reference (reference), paid_at, paid_by_user_id,
-- payment_method_used, final_amount_paid_cents (migrations 015 + 086).
--
-- This migration adds only the two genuinely-new fields:
--   settlement_adjustments.category — broad human-readable label (Fee / Reimbursement /
--     Correction / Credit / Other). The ACCOUNTING DIRECTION is still determined solely
--     by adjustment_type (credit | debit); category is a label only.
--   seller_payouts.payment_note — optional internal note recorded at Mark Paid.
ALTER TABLE settlement_adjustments ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE seller_payouts        ADD COLUMN IF NOT EXISTS payment_note TEXT;
