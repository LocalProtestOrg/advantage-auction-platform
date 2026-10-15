-- 194_session_revocation.sql — server-side session invalidation (security audit 2026-10-15, owner-approved).
--
-- users.session_version: every sign-in token carries the version it was issued under ("sv"). Bumping the version
-- ends every existing session for that account (password reset, account suspension, staff role change / removal of
-- administrator access). Tokens issued before this migration carry no "sv" and are treated as version 0, so nobody
-- is signed out by the rollout itself; they stop working only once their account's version is bumped.
--
-- revoked_sessions: one sign-in lineage ("sid", kept across sliding renewals) ended by signing out, so signing out
-- ends that session on the server, not only in the browser. Rows are needed only until the longest token lifetime
-- has passed and are pruned after two days.
--
-- Additive only. ADD COLUMN ... DEFAULT 0 is a metadata-only change on PostgreSQL 11+ (no table rewrite).

ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS revoked_sessions (
  sid         text PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  reason      text NOT NULL DEFAULT 'logout',
  revoked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_revoked_at ON revoked_sessions (revoked_at);
