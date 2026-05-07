-- Migration: 029_create_invoices.sql
-- Creates invoices table for buyer payment records

CREATE TABLE IF NOT EXISTS invoices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    UUID NOT NULL,
  buyer_user_id UUID NOT NULL,
  auction_id    UUID NOT NULL,
  lot_id        UUID NOT NULL,
  amount_cents  INTEGER NOT NULL,
  status        TEXT DEFAULT 'issued',
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_buyer ON invoices(buyer_user_id);
