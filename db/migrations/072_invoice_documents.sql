-- Migration: 072_invoice_documents.sql
-- Phase 2 (Invoice, Receipt & Document System) — foundation only.
--
-- Adds professional-invoice fields to `invoices` and a generic `generated_documents`
-- registry that the buyer invoice PDFs use today and seller settlement PDFs will
-- reuse later. This migration is ADDITIVE and changes NO charging/tax/payout
-- behavior: buyer_premium_cents / sales_tax_cents / shipping_cents default to 0,
-- and total_cents == hammer_cents == amount_cents for every existing and new row
-- until those features are explicitly activated in a future phase.

-- ── Invoice number sequence ───────────────────────────────────────────────────
-- Single monotonic sequence → human-readable "AAC-000001". Not reset per year,
-- which keeps numbers globally unique and race-free under concurrent inserts.
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

-- ── Invoice columns ───────────────────────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_number       TEXT,
  ADD COLUMN IF NOT EXISTS invoice_date         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS hammer_cents         INTEGER,
  ADD COLUMN IF NOT EXISTS buyer_premium_cents  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sales_tax_cents      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_cents       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cents          INTEGER,
  ADD COLUMN IF NOT EXISTS pdf_public_id        TEXT,
  ADD COLUMN IF NOT EXISTS pdf_sha256           TEXT,
  ADD COLUMN IF NOT EXISTS pdf_generated_at     TIMESTAMPTZ;

-- New rows auto-number via the sequence default (no app dependency, no race).
ALTER TABLE invoices
  ALTER COLUMN invoice_number
  SET DEFAULT ('AAC-' || lpad(nextval('invoice_number_seq')::text, 6, '0'));

-- ── Backfill existing rows ────────────────────────────────────────────────────
-- hammer == total == amount today (hammer-only charging). Premium/tax/shipping
-- stay 0 (their column defaults). invoice_date mirrors the original created_at.
UPDATE invoices
   SET hammer_cents = COALESCE(hammer_cents, amount_cents),
       total_cents  = COALESCE(total_cents,  amount_cents),
       invoice_date = COALESCE(invoice_date, created_at)
 WHERE hammer_cents IS NULL OR total_cents IS NULL;

-- Assign a number to any pre-existing row that lacks one, ordered by creation
-- so historical numbering follows chronology.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM invoices WHERE invoice_number IS NULL ORDER BY created_at ASC, id ASC LOOP
    UPDATE invoices
       SET invoice_number = 'AAC-' || lpad(nextval('invoice_number_seq')::text, 6, '0')
     WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number);

-- ── Generic document registry (reusable foundation) ──────────────────────────
-- One row per generated PDF artifact. doc_type discriminates the artifact kind so
-- buyer invoices and (future) seller settlements share one history surface.
CREATE TABLE IF NOT EXISTS generated_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type        TEXT NOT NULL,                 -- 'buyer_invoice' | (future) 'seller_settlement'
  entity_type     TEXT,                          -- 'invoice' | 'auction' | ...
  entity_id       UUID,                          -- invoice id / auction id / ...
  related_user_id UUID,                          -- buyer or seller the doc belongs to
  file_name       TEXT,
  pdf_public_id   TEXT,                          -- Cloudinary private raw public_id (nullable if storage unconfigured)
  pdf_sha256      TEXT,                          -- SHA-256 of the exact bytes
  byte_size       INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_documents_entity ON generated_documents(doc_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_generated_documents_user   ON generated_documents(related_user_id);
