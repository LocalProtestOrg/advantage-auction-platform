-- 148: Restore the email-verification foundation defined by 082 (ADDITIVE / IDEMPOTENT / NON-BREAKING).
--
-- Why a new migration: production never recorded or applied 082_email_verification.sql (schema drift
-- found 2026-09-10 — schema_migrations jumps 081 -> 083 and none of 082's objects exist). Application
-- code (src/services/emailVerificationService.js) depends on these objects: without the token table
-- the welcome email fails before sending. 082 is NOT edited or re-recorded; this migration re-declares
-- the same objects with IF NOT EXISTS, so it is a no-op on any database where 082 already ran.
--
-- Truthful default for existing accounts: email_verified = false, email_verified_at = NULL. Production
-- never had a token table, so no Advantage.Bid verification could have happened; nothing is backfilled
-- as verified and no verification history is invented. false means "not verified by Advantage.Bid",
-- which is the correct starting point for future provider-asserted verification (AUTH-2).
-- Verification stays OPTIONAL: nothing gates registration, bidding, checkout, or payment on it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verif_token ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verif_user  ON email_verification_tokens(user_id);
