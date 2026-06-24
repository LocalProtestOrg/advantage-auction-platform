-- Migration: 073_invoice_lifecycle.sql
-- Phase 2C — auto-issued (unpaid) invoices + stable paid upsert.
--
-- 1. Allow an invoice to exist before any payment (issued/unpaid invoices created
--    at auction close), so payment_id becomes nullable.
-- 2. Add a natural-key unique index on (lot_id, buyer_user_id) so:
--    - close-time issue is idempotent (ON CONFLICT DO NOTHING), and
--    - payment success UPSERTs the SAME invoice to 'paid' (stable invoice_number),
--      never creating a duplicate.
--
-- No charging/tax/payout change. lot_id and buyer_user_id are NOT NULL on invoices,
-- so a plain unique index is valid (no partial predicate needed).

ALTER TABLE invoices ALTER COLUMN payment_id DROP NOT NULL;

-- Defensive dedup: keep one invoice per (lot_id, buyer_user_id) — prefer a paid
-- row, then the earliest created. (No legitimate duplicates are expected; a lot
-- has a single winner. This guards the unique-index creation across environments.)
DELETE FROM invoices WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY lot_id, buyer_user_id
             ORDER BY (status = 'paid') DESC, created_at ASC, id ASC
           ) AS rn
      FROM invoices
     WHERE lot_id IS NOT NULL AND buyer_user_id IS NOT NULL
  ) t WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_lot_buyer ON invoices(lot_id, buyer_user_id);
