-- Migration: 060_add_users_password_hash.sql
-- Schema reconciliation: users.password_hash exists in production and staging
-- and is read/written by src/routes/auth.js (register INSERT + login
-- bcrypt.compare), but was never declared by a tracked migration. The users
-- table from 001 declares (id, email, role, created_at, last_login) only.
--
-- This migration makes the migration history a faithful, buildable definition
-- of the real schema so a FRESH database created from migrations supports auth.
--
-- Effect:
--   * Fresh DB  -> creates the column (auth.js works).
--   * Prod/stg  -> NO-OP (column already exists); only records this migration
--                  in schema_migrations (ledger reconciliation).
--
-- Intentionally NULLABLE for now. The app always sets password_hash on insert;
-- a future migration may add NOT NULL after a verified backfill. Do not add
-- NOT NULL here (an env with a legacy NULL row would fail).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;
