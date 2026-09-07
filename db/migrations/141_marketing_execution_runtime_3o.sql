-- 141_marketing_execution_runtime_3o.sql — Phase 3O execution runtime spine. ADDITIVE + idempotent +
-- production-safe. Extends the mig-140 obligation ledger (append-only history, BLOCKED/NEEDS_OWNER
-- metadata, feature/ladder/wave/window), and adds the Desktop Marketing operating-bridge interface tables +
-- channel readiness. NOTHING charges/sends/spends/flips a gate. State casing stays lowercase (mapped to the
-- UPPERCASE contract at the boundary — see docs/marketing/phase3o-schema-diff.md).

-- ── 1. Obligation state-machine extensions ──
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS feature_key        TEXT;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS ladder_id          TEXT;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS wave               TEXT;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS window_earliest    TIMESTAMPTZ;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS window_latest      TIMESTAMPTZ;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS must_start_by      TIMESTAMPTZ;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS previous_state     TEXT;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS blocked_reason     TEXT;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS retry_after        TIMESTAMPTZ;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS deadline_at        TIMESTAMPTZ;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS attempts           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS needs_owner_reason TEXT;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS needs_owner_options JSONB;
ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS terminal_at        TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_obligation_due ON marketing_obligations(state, retry_after);

-- ── 2. Append-only obligation state history (never rewritten; terminal states never retro-edited) ──
CREATE TABLE IF NOT EXISTS marketing_obligation_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id  UUID NOT NULL REFERENCES marketing_obligations(id) ON DELETE CASCADE,
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  rung           TEXT,                         -- ladder rung attempted, if any
  reason         TEXT,
  evidence       JSONB NOT NULL DEFAULT '{}',
  shadow         BOOLEAN NOT NULL DEFAULT false, -- true = certification/shadow evidence, NOT seller fulfillment
  actor          TEXT,                         -- 'runtime' | 'director' | admin id
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_obligation_events_ob ON marketing_obligation_events(obligation_id, created_at);

-- ── 3. Desktop Marketing operating bridge (structured messages ONLY; no remote command; no PII/creds) ──
CREATE TABLE IF NOT EXISTS marketing_desktop_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('desktop_to_vs','vs_to_desktop','desktop_to_owner','vs_to_owner')),
  message_type   TEXT NOT NULL,               -- RULE_PROPOSAL | CONFIG_PROPOSAL | RUNTIME_EXPORT | ...
  contract_version TEXT NOT NULL DEFAULT '3O.1',
  body           JSONB NOT NULL DEFAULT '{}',
  schema_valid   BOOLEAN NOT NULL DEFAULT false,
  schema_errors  JSONB,
  applies_via    TEXT CHECK (applies_via IN ('pull_request','admin_config_editor','admin_version_registry','fidelity_review_queue','report_only')),
  status         TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','validated','rejected','routed','applied')),
  applied_ref    TEXT,                         -- audit link proposal → eventual applied change
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_desktop_msg_dir ON marketing_desktop_messages(direction, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_desktop_msg_id ON marketing_desktop_messages(message_id);

-- ── 4. Anonymized runtime exports to Desktop Marketing (no names/emails/addresses/cards/recipients) ──
CREATE TABLE IF NOT EXISTS marketing_runtime_exports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id    TEXT NOT NULL,
  window_label TEXT,
  payload      JSONB NOT NULL DEFAULT '{}',    -- aggregate/opaque-id only
  contains_pii BOOLEAN NOT NULL DEFAULT false, -- MUST remain false (asserted by exporter + tests)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 5. Channel readiness (6 Phase 3O states) ──
CREATE TABLE IF NOT EXISTS marketing_channel_readiness (
  channel_key  TEXT PRIMARY KEY,
  state        TEXT NOT NULL CHECK (state IN ('NOT_CONFIGURED','CONFIGURED_UNVERIFIED','SHADOW_CERTIFIED','ACTIVE','PAUSED','REVOKED')),
  preconditions JSONB NOT NULL DEFAULT '[]',
  owner_action_required TEXT,
  fallback_ladder TEXT,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Seed readiness: internal channels ACTIVE; external send/publish/spend channels SHADOW_CERTIFIED (software
-- built) — real activation is an OWNER/PROVIDER dependency, NOT flipped here.
INSERT INTO marketing_channel_readiness (channel_key, state, owner_action_required, fallback_ladder) VALUES
  ('marketplace', 'ACTIVE',           NULL, NULL),
  ('homepage',    'ACTIVE',           NULL, NULL),
  ('creative',    'ACTIVE',           NULL, NULL),
  ('reporting',   'ACTIVE',           NULL, NULL),
  ('service',     'ACTIVE',           NULL, NULL),
  ('onsite',      'SHADOW_CERTIFIED', 'Enable marketing.onsite.enabled', 'L_placement_soft'),
  ('email',       'SHADOW_CERTIFIED', 'Activate A7 email send + SES event destination', 'L_shared_edition'),
  ('social',      'SHADOW_CERTIFIED', 'Connect Facebook/Instagram provider', 'L_social'),
  ('paid',        'SHADOW_CERTIFIED', 'Activate Google/Meta advertising account', 'L_paid')
ON CONFLICT (channel_key) DO NOTHING;
