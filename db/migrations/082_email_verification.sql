-- 082: Email verification (Launch Sprint 2). ADDITIVE / NON-BREAKING.
-- Records email verification status + tokens. Verification is OPTIONAL at launch: nothing
-- gates registration/bidding/checkout/payment on it (primary identity remains Stripe
-- card-on-file + the existing registration flow). Mandatory verification can be enabled later.
-- No Stripe/settlement/payment/tax behavior. Idempotent.

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
