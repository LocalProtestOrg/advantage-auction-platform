-- 142_marketing_director_ledger.sql — Phase 3O: persist bounded Marketing Director decisions + complete the
-- paid-allocation ledger against the snapshotted internal authority. ADDITIVE + idempotent. NOTHING
-- charges/sends/spends/flips a gate. The 60% direct-fulfillment figure remains CONFIDENTIAL, versioned, a
-- CEILING only, and NEVER seller-facing.

-- ── Bounded Director decision records (replayable via inputs_hash) ──
CREATE TABLE IF NOT EXISTS marketing_director_decisions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id              TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('PLAN','SELECT_DISCRETIONARY','SCHEDULE','SCOPE_AUDIENCE','ADJUST','RUNG_ADVANCE','UPSELL_PROMPT','ESCALATE')),
  purchase_id              TEXT NOT NULL,
  obligation_ids           JSONB NOT NULL DEFAULT '[]',
  inputs_hash              TEXT NOT NULL,          -- hash of snapshot + config + readiness + health inputs
  authority_cents_remaining INTEGER NOT NULL DEFAULT 0,
  evidence_line            TEXT NOT NULL,          -- INTERNAL reason; never rendered to sellers
  outputs                  JSONB NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_director_decision ON marketing_director_decisions(decision_id);
CREATE INDEX IF NOT EXISTS idx_director_decision_purchase ON marketing_director_decisions(purchase_id, created_at DESC);

-- ── Paid-allocation ledger: reserve/spend/release against the snapshotted authority ceiling ──
-- One current-balance row per purchase + an append-only entry log. reserved+spent may NEVER exceed the
-- ceiling (DB CHECK + conditional service updates). NO seller identity here — this is Advantage.Bid's own
-- internal money (accounting separation, mirrors mig 126).
CREATE TABLE IF NOT EXISTS marketing_paid_allocations (
  purchase_kind    TEXT NOT NULL CHECK (purchase_kind IN ('package','additional_promotion')),
  purchase_id      UUID NOT NULL,
  ceiling_cents    INTEGER NOT NULL CHECK (ceiling_cents >= 0),
  reserved_cents   INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  spent_cents      INTEGER NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  released_cents   INTEGER NOT NULL DEFAULT 0 CHECK (released_cents >= 0),
  policy_version   TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (purchase_kind, purchase_id),
  CONSTRAINT chk_paid_alloc_ceiling CHECK (reserved_cents + spent_cents <= ceiling_cents)
);
CREATE TABLE IF NOT EXISTS marketing_paid_allocation_entries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_kind    TEXT NOT NULL,
  purchase_id      UUID NOT NULL,
  entry_type       TEXT NOT NULL CHECK (entry_type IN ('RESERVE','SPEND','RELEASE','RECONCILE')),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  provider_ref     TEXT,
  campaign_ref     TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,           -- retry-safe: a repeated op writes no second row
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: intentionally NO seller identity column (internal money).
);
CREATE INDEX IF NOT EXISTS idx_paid_alloc_entries ON marketing_paid_allocation_entries(purchase_kind, purchase_id, created_at);
