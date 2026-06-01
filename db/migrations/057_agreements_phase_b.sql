-- Migration: 057_agreements_phase_b.sql
-- Seller Agreement System — Phase B. Widen agreements.status to the full
-- lifecycle and add send/sign/lifecycle columns. Additive + constraint swap.
-- No rows exist yet on the target (Phase A created the tables), so the status
-- CHECK swap is safe.

-- 1. Widen the status CHECK (056 created an inline, auto-named constraint).
DO $$
DECLARE cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'agreements'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%IN%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agreements DROP CONSTRAINT %I', cname);
  END IF;
END$$;

ALTER TABLE agreements DROP CONSTRAINT IF EXISTS agreements_status_check;
ALTER TABLE agreements
  ADD CONSTRAINT agreements_status_check
  CHECK (status IN ('draft','sent','viewed','signed','expired','superseded','revoked','countersigned'));

-- 2. Additive lifecycle columns.
ALTER TABLE agreements
  ADD COLUMN IF NOT EXISTS access_token_hash          TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by_agreement_id UUID,
  ADD COLUMN IF NOT EXISTS revoked_at                 TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoke_reason              TEXT,
  ADD COLUMN IF NOT EXISTS pdf_status                 TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS signed_pdf_public_id       TEXT;  -- Cloudinary private asset id; delivered via short-lived signed URLs

CREATE INDEX IF NOT EXISTS idx_agreements_token_hash ON agreements(access_token_hash);
