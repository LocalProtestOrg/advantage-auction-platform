-- 094: BD → Advantage.Bid identity bridge foundation (Option B). ADDITIVE + idempotent.
--
-- Supports the FLAG-GATED (IDENTITY_BRIDGE_ENABLED, default false), NON-PRODUCTION seamless-login
-- PoC. Reuses the existing users table + JWT — no change to existing authentication. Numbered 094
-- (093 is reserved by the unmerged Marketplace Events PR); this migration depends only on `users`.

BEGIN;

-- Links a provider identity (BD member) to an Advantage.Bid user. Identity only — never ownership.
CREATE TABLE IF NOT EXISTS external_identities (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                   TEXT NOT NULL,                 -- 'brilliant_directories'
  provider_subject           TEXT NOT NULL,                 -- the BD user_id
  provider_email             TEXT,
  provider_status            TEXT,
  provider_subscription_id   TEXT,
  provider_subscription_name TEXT,
  linked_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at           TIMESTAMPTZ,
  metadata_json              JSONB NOT NULL DEFAULT '{}',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS idx_external_identities_user ON external_identities(user_id);

-- Short-lived, single-use, HASHED opaque handoff codes (the raw code is never stored).
CREATE TABLE IF NOT EXISTS bd_login_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   TEXT NOT NULL UNIQUE,          -- sha256(opaque code)
  bd_user_id  TEXT NOT NULL,
  dest        TEXT NOT NULL,                 -- allowlisted route KEY (never a URL)
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,                   -- single-use: set atomically on redemption
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bd_login_codes_expires ON bd_login_codes(expires_at);

-- Mark accounts provisioned by the bridge (created as buyer only; never auto-elevated).
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source TEXT NOT NULL DEFAULT 'native';

COMMIT;
