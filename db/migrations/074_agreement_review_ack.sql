-- Migration: 074_agreement_review_ack.sql
-- Part A: server-side seller-agreement REVIEW acknowledgment. ADDITIVE + reversible.
-- Records that the seller affirmed they read/reviewed the agreement at signing time.
-- The accepted VERSION is already pinned by agreements.template_version_id and the
-- exact content by agreement_signatures.content_sha256; review IP/UA are already
-- captured by agreement_signatures.ip_address/user_agent (same request), so only the
-- acknowledgment flag + timestamp are added here.
ALTER TABLE agreement_signatures
  ADD COLUMN IF NOT EXISTS reviewed_acknowledged    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviewed_acknowledged_at TIMESTAMPTZ NULL;
