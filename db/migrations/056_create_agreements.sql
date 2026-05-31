-- Migration: 056_create_agreements.sql
-- Seller Agreement System — Phase A creates the schema; Phase B wires send/sign.
-- agreements pins template_version_id (the exact version signed) and freezes
-- party_snapshot + resolved_variables + rendered_body so a signed contract is
-- forever reproducible. agreement_signatures records attribution (server
-- timestamp, IP, user-agent) and content_sha256 for tamper-evidence.
-- Audit trail reuses the existing audit_log table (no migration needed).
-- These tables are created now but NOT exercised until Phase B.

CREATE TABLE IF NOT EXISTS agreements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_version_id UUID NOT NULL REFERENCES agreement_template_versions(id),
  seller_profile_id   UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  seller_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                        'draft','sent','viewed','signed','countersigned','void','expired')),
  party_snapshot      JSONB,
  resolved_variables  JSONB,
  rendered_body       TEXT,
  sent_at             TIMESTAMPTZ,
  viewed_at           TIMESTAMPTZ,
  signed_at           TIMESTAMPTZ,
  void_at             TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  signed_pdf_url      TEXT,
  signed_pdf_sha256   TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agreement_signatures (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id         UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  signer_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  signer_role          TEXT CHECK (signer_role IN ('seller','admin')),
  method               TEXT CHECK (method IN ('typed','drawn')),
  typed_name           TEXT,
  drawn_image_url      TEXT,
  consent_acknowledged BOOLEAN NOT NULL DEFAULT false,
  intent_statement     TEXT,
  content_sha256       TEXT,
  signed_at            TIMESTAMPTZ,
  ip_address           TEXT,
  user_agent           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agreements_seller ON agreements(seller_profile_id);
CREATE INDEX IF NOT EXISTS idx_agreements_status ON agreements(status);
CREATE INDEX IF NOT EXISTS idx_agreement_signatures_agreement ON agreement_signatures(agreement_id);
