-- 222_platform_owner_and_config_audit.sql - Platform-owner designation, platform setting audit trail, owner notice addresses.
-- Owner-authorized baseline correction (2026-11-06). Additive only:
--   1. users.is_platform_owner (default false). The migration designates NOBODY. The owner designates one active admin
--      account at deploy with scripts/prod-set-platform-owner.js. Until then every sensitive platform setting write is
--      refused (fail closed), except automated safety stops (the paid emergency stop, outreach stop switches).
--   2. platform_setting_audit: one row per platform setting write (who, when, which key, previous and new value with
--      anything that looks secret masked, whether it was sensitive and whether the owner was notified).
--   3. platform_config owner.notify_emails: where owner security notices are emailed. A sensitive key (owner.*), so only
--      the platform owner can change it afterwards. Inserted only when absent; an existing value is never overwritten.
-- Changes no existing row other than adding the new column with its default.
-- Reverse:
--   DELETE FROM platform_config WHERE key = 'owner.notify_emails';
--   DROP TABLE IF EXISTS platform_setting_audit;
--   ALTER TABLE users DROP COLUMN IF EXISTS is_platform_owner;

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_owner BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS platform_setting_audit (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key           TEXT NOT NULL CHECK (length(config_key) BETWEEN 1 AND 200),
  previous_value       JSONB,
  new_value            JSONB,
  sensitive            BOOLEAN NOT NULL DEFAULT false,
  actor_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('user','system')),
  actor_label          TEXT,
  source               TEXT,
  owner_notified_at    TIMESTAMPTZ,
  owner_notify_result  JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_setting_audit_key ON platform_setting_audit (config_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_setting_audit_created ON platform_setting_audit (created_at DESC);

INSERT INTO platform_config (key, value, category, description)
VALUES ('owner.notify_emails', '["tylerwitt2015@gmail.com","advantageauction.bid@gmail.com"]'::jsonb, 'owner',
        'Email addresses that receive owner security notices (sensitive settings, paid advertising authority). Platform owner only.')
ON CONFLICT (key) DO NOTHING;
