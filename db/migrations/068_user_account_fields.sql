-- 068_user_account_fields.sql
-- ACCOUNT/BUYER OPS sprint (Track 2). Additive + idempotent.
--   • users.full_name / users.phone — editable contact fields (admin + buyer-self).
--   • user_admin_notes — append-only internal admin memos on a user (authored,
--     timestamped). NOT card/payment data. All writes also audit-logged.
-- No data is destroyed; no existing column/constraint is altered.

ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone     TEXT;

CREATE TABLE IF NOT EXISTS user_admin_notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note       TEXT NOT NULL,
  actor_id   UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_admin_notes_user
  ON user_admin_notes (user_id, created_at DESC);
