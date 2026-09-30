-- 183: Sasha IMAP ingestion of info@advantage.bid (Stage 0/1, 2026-09-30). ADDITIVE / IDEMPOTENT.
-- Reads the info@advantage.bid mailbox READ-ONLY (EXAMINE + BODY.PEEK; the reader cannot delete, move, flag or append)
-- and hands each new message to the SAME Sasha email pipeline the SES route uses. Both switches ship OFF:
--   sasha.imap_read_enabled     connect and RECORD new messages (shadow: classify only, nothing answered)
--   sasha.imap_process_enabled  hand recorded messages to Sasha (requires imap_read_enabled)
-- No row in any existing table changes.

-- ── One row per mailbox message ever seen (never the historical backlog: the first poll only sets a bookmark) ──
CREATE TABLE IF NOT EXISTS imap_inbound_messages (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox            text        NOT NULL,                 -- e.g. "info@advantage.bid/INBOX" (no credentials)
  uidvalidity        bigint      NOT NULL,
  uid                bigint      NOT NULL,
  message_id         text,                                 -- RFC Message-ID header (normalized <...>)
  content_fingerprint text,                                -- sha256(from|date|subject|body) for mail without a Message-ID
  from_email         text,
  subject            text,
  internal_date      timestamptz,
  size_bytes         integer,
  raw_sha256         text,
  status             text        NOT NULL DEFAULT 'recorded'
                     CHECK (status IN ('recorded','shadow','processed','ignored','duplicate','too_old','spam_flagged','failed')),
  outcome            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  attempts           integer     NOT NULL DEFAULT 0,
  last_error         text,
  conversation_id    uuid        REFERENCES cs_conversations(id) ON DELETE SET NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox, uidvalidity, uid)                        -- layer 1: a mailbox position is recorded exactly once
);
CREATE INDEX IF NOT EXISTS idx_imap_inbound_status ON imap_inbound_messages (status, recorded_at);
CREATE INDEX IF NOT EXISTS idx_imap_inbound_msgid ON imap_inbound_messages (message_id) WHERE message_id IS NOT NULL;

-- ── Mailbox bookmark + health (one row per mailbox) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS imap_mailbox_state (
  mailbox              text        PRIMARY KEY,
  uidvalidity          bigint,
  last_seen_uid        bigint,
  baseline_at          timestamptz,                         -- when the starting position was set (backlog never answered)
  status               text        NOT NULL DEFAULT 'idle'
                       CHECK (status IN ('idle','disabled','not_configured','ok','error','auth_failed')),
  last_poll_at         timestamptz,
  last_success_at      timestamptz,
  last_message_at      timestamptz,
  last_error           text,                                -- redacted; never a credential
  consecutive_failures integer     NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz,
  auth_failed_at       timestamptz,                         -- fail-closed latch: no login attempts until a Super Admin clears it
  uidvalidity_changed_at timestamptz,
  messages_today       integer     NOT NULL DEFAULT 0,
  messages_today_date  date,
  alerts               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── Layer 3 duplicate protection for Sasha: mail WITHOUT a Message-ID is deduplicated by content fingerprint ──
-- (Layer 2, the existing unique inbound Message-ID index uq_cs_messages_inbound_msgid, is unchanged.)
ALTER TABLE cs_messages ADD COLUMN IF NOT EXISTS content_fingerprint text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_messages_inbound_fingerprint ON cs_messages (content_fingerprint)
  WHERE direction = 'inbound' AND email_message_id IS NULL AND content_fingerprint IS NOT NULL;

-- ── Switches: both OFF ──────────────────────────────────────────────────────────────────────────────
INSERT INTO platform_config (key, value, category) VALUES
  ('sasha.imap_read_enabled',    'false'::jsonb, 'sasha'),
  ('sasha.imap_process_enabled', 'false'::jsonb, 'sasha')
ON CONFLICT (key) DO NOTHING;
