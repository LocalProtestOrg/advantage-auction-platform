-- 184: IMAP poller lease (2026-10-01). ADDITIVE / IDEMPOTENT.
-- Replaces the session advisory lock used by the info@ mailbox poller. Production reaches Postgres through a
-- transaction-mode connection pooler, where a session lock and its unlock can land on different server connections,
-- so the lock was stranded and every later poll silently skipped. A lease stored on the mailbox row is taken with one
-- atomic UPDATE (pooler-safe) and expires by itself if the holding process dies.
ALTER TABLE imap_mailbox_state ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE imap_mailbox_state ADD COLUMN IF NOT EXISTS lease_until timestamptz;
