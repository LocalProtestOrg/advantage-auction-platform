-- Migration: 055_create_seller_identity.sql
-- Seller Agreement System — Phase A. Expanded seller identity capture for
-- agreements (legal name, company, signatory, address, phone). 1:1 with
-- seller_profiles. SECURITY: payout_info_ref stores only a tokenized /
-- non-sensitive reference (e.g. a seller_payout_preferences id) — never raw
-- bank/card numbers. PII columns are candidates for encryption in a later
-- phase before seller-facing capture (precedent: auctions.address_encrypted).

CREATE TABLE IF NOT EXISTS seller_identity (
  seller_profile_id UUID PRIMARY KEY REFERENCES seller_profiles(id) ON DELETE CASCADE,
  legal_name        TEXT,
  company_name      TEXT,
  signatory_name    TEXT,
  signatory_title   TEXT,
  address_line1     TEXT,
  address_line2     TEXT,
  city              TEXT,
  state             TEXT,
  postal_code       TEXT,
  country           TEXT,
  phone             TEXT,
  payout_info_ref   TEXT,
  updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
