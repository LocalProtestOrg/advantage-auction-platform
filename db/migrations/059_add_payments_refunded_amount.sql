-- Migration: 059_add_payments_refunded_amount.sql
-- (Renumbered from 047 during Line B reconciliation onto e0f005f; 046/047 were
--  already taken by production-applied migrations. Content unchanged.)
-- Phase 1 Sub-batch 2 — refund integrity hardening (C-4 overspend protection)
--
-- Adds cumulative refund tracking on the payments table so:
--   * processRefund can validate refundAmountCents + refunded_amount_cents <= amount_cents
--   * _handleChargeRefunded (Stripe webhook) can write Stripe's authoritative
--     amount_refunded back to the DB without losing partial-refund truth on
--     subsequent attempts
--   * Sequential partial refunds collapse to a single, bounded ledger value
--
-- DEPLOYMENT ORDER
--   This migration MUST run BEFORE Sub-batch 2 application code is deployed.
--   The new code references refunded_amount_cents in processRefund and in the
--   charge.refunded webhook handler. Old code is unaffected (it never reads or
--   writes the new column).
--
-- PRE-MIGRATION OPERATOR CHECK
--   Before applying this migration to ANY environment, run:
--     SELECT COUNT(*) FROM payments WHERE status = 'partially_refunded';
--
--   If the count is > 0, document the affected rows and plan a post-migration
--   reconciliation pass against Stripe's true amount_refunded value. The
--   backfill below conservatively marks every partially_refunded row as fully
--   refunded (blocking further refunds) so operator action is required to
--   restore the true partial state.
--
-- ROLLBACK (additive — safe to revert)
--   ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_refunded_amount_bounded;
--   ALTER TABLE payments DROP COLUMN IF EXISTS refunded_amount_cents;
--   (Drop the CONSTRAINT before the COLUMN.)

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS refunded_amount_cents INTEGER NOT NULL DEFAULT 0;

-- Backfill 1: fully-refunded rows have refunded the full amount by definition.
UPDATE payments
   SET refunded_amount_cents = amount_cents
 WHERE status = 'refunded'
   AND refunded_amount_cents = 0;

-- Backfill 2: partially_refunded rows — true value is unknown without a Stripe
-- round-trip. Conservatively mark fully refunded so further refund attempts
-- are blocked until an operator reads Stripe's amount_refunded and adjusts.
-- See docs/sop-refunds.md for the reconciliation procedure.
UPDATE payments
   SET refunded_amount_cents = amount_cents
 WHERE status = 'partially_refunded'
   AND refunded_amount_cents = 0;

-- CHECK constraint enforces invariant I-5: refunded_amount_cents is always in
-- [0, amount_cents]. Added AFTER backfill so the backfill cannot violate it.
ALTER TABLE payments
  ADD CONSTRAINT chk_refunded_amount_bounded
    CHECK (refunded_amount_cents >= 0 AND refunded_amount_cents <= amount_cents);
