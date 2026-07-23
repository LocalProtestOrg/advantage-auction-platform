-- 095_bd_bridge_contact_identity.sql
-- Additive + idempotent. Supports the BD identity bridge's real-contact/identity capture:
--  * users.contact_email — real deliverable inbox for bridge-created accounts, whose users.email is a
--    namespaced internal login identifier (never emailed). NULL for all native accounts.
--  * external_identities.provider_first_name / provider_last_name — real name fields for reference.
--  * bd_login_codes.provider_email / provider_first_name / provider_last_name — the authenticated
--    identity claims carried transiently with the one-time code (set at exchange, consumed at return).
-- No data is modified; native accounts are unaffected (contact_email stays NULL → mail uses users.email).

BEGIN;

ALTER TABLE users               ADD COLUMN IF NOT EXISTS contact_email        TEXT;

ALTER TABLE external_identities ADD COLUMN IF NOT EXISTS provider_first_name  TEXT;
ALTER TABLE external_identities ADD COLUMN IF NOT EXISTS provider_last_name   TEXT;

ALTER TABLE bd_login_codes      ADD COLUMN IF NOT EXISTS provider_email       TEXT;
ALTER TABLE bd_login_codes      ADD COLUMN IF NOT EXISTS provider_first_name  TEXT;
ALTER TABLE bd_login_codes      ADD COLUMN IF NOT EXISTS provider_last_name   TEXT;

COMMIT;
