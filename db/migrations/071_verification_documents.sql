-- Migration: 071_verification_documents.sql
-- Verification Documents + risk foundation. ADDITIVE only (new tables + nullable
-- columns). No changes to payments/payout/premium/terms. Reversible.
--
-- Model: one admin REQUEST can ask for multiple document CATEGORIES; the seller
-- uploads one or more DOCUMENTS (each tied to a request + category) into secure
-- private storage. Categories use TEXT + CHECK (not an enum) per spec.

-- Risk + publication-gate metadata on the seller (NOT required at signup; defaults
-- keep every existing seller unaffected: low risk, no publication gate).
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'low'
  CHECK (risk_level IN ('low','medium','high'));
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS risk_notes TEXT NULL;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS verification_required_before_publication BOOLEAN NOT NULL DEFAULT false;

-- A verification request from an admin to a seller.
CREATE TABLE IF NOT EXISTS verification_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_profile_id UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  requested_by  UUID REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','submitted','approved','rejected','more_info','cancelled')),
  message       TEXT NULL,                 -- admin note to the seller (what/why)
  admin_notes   TEXT NULL,                 -- internal admin notes (not shown to seller)
  reviewed_by   UUID REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_requests_seller ON verification_requests(seller_profile_id, status);

-- The document categories requested in a given request (one request -> many categories).
CREATE TABLE IF NOT EXISTS verification_request_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID NOT NULL REFERENCES verification_requests(id) ON DELETE CASCADE,
  category    TEXT NOT NULL
              CHECK (category IN ('government_id','passport','business_license','tax_document',
                                  'proof_of_ownership','receipt_invoice','estate_authority',
                                  'probate_letter','other')),
  UNIQUE (request_id, category)
);

-- Uploaded documents (secure private storage). One row per uploaded file.
CREATE TABLE IF NOT EXISTS verification_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES verification_requests(id) ON DELETE CASCADE,
  seller_profile_id UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  category      TEXT NOT NULL
                CHECK (category IN ('government_id','passport','business_license','tax_document',
                                    'proof_of_ownership','receipt_invoice','estate_authority',
                                    'probate_letter','other')),
  storage_public_id TEXT NOT NULL,         -- Cloudinary PRIVATE asset id
  file_sha256   TEXT NULL,
  original_filename TEXT NULL,
  content_type  TEXT NULL,
  byte_size     INTEGER NULL,
  status        TEXT NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted','approved','rejected','more_info')),
  review_note   TEXT NULL,
  uploaded_by   UUID REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   UUID REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_documents_request ON verification_documents(request_id);
CREATE INDEX IF NOT EXISTS idx_verification_documents_seller ON verification_documents(seller_profile_id);
