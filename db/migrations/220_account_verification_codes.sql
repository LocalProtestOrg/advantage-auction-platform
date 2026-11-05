-- 220_account_verification_codes.sql - One-time codes emailed to an account to confirm a sensitive change when the account
-- has no password it can confirm with (owner decision 2026-11-05: payout destination changes; no unverified bypass).
-- Additive only: one new, empty table. Changes no existing row's behavior.
--
-- Who needs it: accounts that sign in without a password of their own (the directory sign-in bridge, auth_source
-- 'bd_bridge', whose stored hash is random bytes nobody holds; or an account with no password hash at all). Accounts with a
-- password keep confirming with their current password.
-- Controls (src/services/accountVerificationCodeService.js): a code is never stored (HMAC of record id + code,
-- src/lib/verificationCode.js), bound to the account and to one purpose, 10 minutes, single use, 5 attempts per code
-- (counted atomically), 3 codes per 30 minutes, a one-hour lockout after 10 wrong attempts. Rows are kept as history.
-- Reverse: DROP TABLE account_verification_codes;

CREATE TABLE IF NOT EXISTS account_verification_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  purpose        TEXT NOT NULL CHECK (purpose IN ('payout_destination_change')),
  code_hash      TEXT,
  sent_to        TEXT,                                   -- masked address only (for example j***@example.com)
  status         TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'used', 'failed', 'expired', 'superseded', 'send_failed')),
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts   INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_verification_codes_used_has_time CHECK (status <> 'used' OR used_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_account_verification_codes_user ON account_verification_codes (user_id, purpose, created_at DESC);
