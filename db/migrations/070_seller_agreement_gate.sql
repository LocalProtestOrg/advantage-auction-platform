-- Migration: 070_seller_agreement_gate.sql
-- Seller Agreement System v1 - onboarding/dashboard gate support.
-- ADDITIVE columns only. No table creation, no renames, no type changes, no
-- backfill. Fully reversible (drop the three columns). Grandfathering of
-- existing sellers is handled in application logic (a seller with any non-draft
-- auction has dashboard access), so no data write is required here.

-- Admin override / explicit waiver of the agreement gate for a seller.
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS agreement_waived_at TIMESTAMPTZ NULL;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS agreement_waived_by UUID NULL REFERENCES users(id);

-- Idempotency stamp for emailing the signed PDF to the seller (req 5).
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signed_pdf_emailed_at TIMESTAMPTZ NULL;
