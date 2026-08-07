-- Migration: 107_business_and_tax_exemption_docs.sql
-- H-1 launch support: (A) Professional Seller business-document verification fields + document
-- categories (reuses verification_requests/verification_documents), and (B) Buyer sales-tax
-- exemption document workflow. ADDITIVE + reversible: new nullable columns, expanded CHECK lists,
-- one new table, one new boolean on users (default false → every existing buyer stays taxable).
-- Does NOT enable sales tax and does NOT change payments/premium/settlement.

-- ── PART A: Professional Seller business identity fields (1:1 seller_identity) ────────────────────
-- Legal Business Name → seller_identity.legal_name (existing). Business Address → existing address_*.
-- Business Type → seller_profiles.seller_type (existing). Add EIN + DBA (both nullable, sensitive).
ALTER TABLE seller_identity ADD COLUMN IF NOT EXISTS ein      TEXT NULL;  -- IRS EIN (sensitive; masked in client responses)
ALTER TABLE seller_identity ADD COLUMN IF NOT EXISTS dba_name TEXT NULL;  -- "doing business as" / trade name

-- Expand the verification document categories to cover business credentials. business_license already
-- exists; add IRS EIN verification (CP575 / 147C / equivalent) and state registration/formation.
ALTER TABLE verification_request_categories DROP CONSTRAINT IF EXISTS verification_request_categories_category_check;
ALTER TABLE verification_request_categories ADD  CONSTRAINT verification_request_categories_category_check
  CHECK (category IN ('government_id','passport','business_license','tax_document',
                      'proof_of_ownership','receipt_invoice','estate_authority','probate_letter',
                      'ein_verification','business_registration','other'));

ALTER TABLE verification_documents DROP CONSTRAINT IF EXISTS verification_documents_category_check;
ALTER TABLE verification_documents ADD  CONSTRAINT verification_documents_category_check
  CHECK (category IN ('government_id','passport','business_license','tax_document',
                      'proof_of_ownership','receipt_invoice','estate_authority','probate_letter',
                      'ein_verification','business_registration','other'));

-- ── PART B: Buyer sales-tax exemption ────────────────────────────────────────────────────────────
-- Authoritative quick flag (review-maintained mirror of an approved, non-expired exemption record).
-- Default false → no buyer is exempt until an admin approves. Never set by the upload itself.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT false;

-- The authoritative exemption record. Carries the certificate document (secure private storage) plus the
-- structured fields future per-jurisdiction tax logic will evaluate: type, state, effective/expiration.
CREATE TABLE IF NOT EXISTS buyer_tax_exemptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'under_review'
                 CHECK (status IN ('under_review','approved','rejected','more_info')),
  exemption_type TEXT NULL,                     -- resale | state_exemption | streamlined_sst | mtc | other
  jurisdiction_state TEXT NULL,                 -- 2-letter state the exemption applies to
  certificate_number TEXT NULL,                 -- permit/certificate number (buyer-provided)
  effective_date DATE NULL,                     -- admin-recorded on approval
  expiration_date DATE NULL,                    -- admin-recorded (nullable = no expiry)
  storage_public_id  TEXT NULL,                 -- Cloudinary PRIVATE asset id (never public)
  file_sha256    TEXT NULL,
  original_filename TEXT NULL,
  content_type   TEXT NULL,
  byte_size      INTEGER NULL,
  admin_notes    TEXT NULL,                     -- internal admin notes (never shown to buyer)
  submitted_by   UUID REFERENCES users(id),
  reviewed_by    UUID REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One active exemption record per buyer (re-submit updates it). Partial-unique keeps history simple.
CREATE UNIQUE INDEX IF NOT EXISTS idx_buyer_tax_exemptions_buyer ON buyer_tax_exemptions(buyer_user_id);
