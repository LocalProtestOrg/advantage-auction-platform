-- OPS-3: add is_active column to users so admin can suspend accounts.
--
-- Background: users.is_active was referenced by seed-test-fixtures.js but
-- never added via a tracked migration. The column did not exist on
-- production/staging Postgres, which broke OPS-3's suspend/unsuspend
-- endpoints (UPDATE failed with 500) and made the auth.js login is_active
-- guard a silent no-op (undefined === false evaluates false).
--
-- This migration adds the column with DEFAULT true so every existing user
-- becomes is_active=true automatically — preserving pre-OPS-3 login behavior
-- exactly. After this lands, OPS-3 endpoints become fully functional.
--
-- IF NOT EXISTS makes the migration safe to re-run on any DB that already
-- has the column (defensive for any pre-existing schema drift).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Index for the auth.js login query path (SELECT * FROM users WHERE email
-- = $1 already uses the email index; is_active is read but not filtered
-- in WHERE, so no additional index is needed). The admin sellers query
-- groups by sp.id, u.id so is_active is fetched per row without scan.
