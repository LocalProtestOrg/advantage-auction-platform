-- 126_marketing_agency_foundation.sql — Autonomous Marketing Agency Phase 3A foundational/control layer.
--
-- ADDITIVE ONLY. Extends marketing_jobs; adds the internal marketing allocation/ledger (NO seller_user_id,
-- never seller-facing), the Growth Pool + monthly authority, Growth markets, campaign lifecycle + radius
-- exceptions, creative provenance + QA, the durable transactional job queue (outbox), the agent registry,
-- and the centralized marketing.* config. Nothing here activates autonomous marketing.
--
-- CRITICAL ACCOUNTING SEPARATION: the seller marketing-package charge (Concept A: package_price_cents,
-- seller-facing, in settlement) is structurally separate from Advantage.Bid's internal 60% direct-spend
-- ceiling (Concept B: direct_max_cents, internal only). The internal ledgers below MUST NOT carry
-- seller_user_id and are never exposed to any seller-facing surface.

-- ── 1. marketing_jobs: allocation snapshot + campaign fields (immutable after freeze) ─
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS package_id             UUID REFERENCES marketing_packages(id);
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS package_price_cents    INTEGER;      -- Concept A: seller charge (snapshot)
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS direct_max_cents       INTEGER;      -- Concept B: internal 60% ceiling (snapshot)
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS growth_allocation_cents INTEGER;     -- remainder = price - direct_max (snapshot)
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS allocation_model_version TEXT;       -- e.g. 'v1'
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS allocation_frozen_at   TIMESTAMPTZ;  -- freeze stamp (immutable after)
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS settlement_adjustment_id UUID;       -- link to the seller-facing debit (Concept A)
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS fulfillment_state      TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS campaign_class         TEXT;         -- event_local | buyer | seller | professional_seller | brand | growth
-- Invariant backstop (only when the snapshot is present): direct_max + growth = price, exactly.
ALTER TABLE marketing_jobs DROP CONSTRAINT IF EXISTS chk_marketing_jobs_allocation_sum;
ALTER TABLE marketing_jobs ADD  CONSTRAINT chk_marketing_jobs_allocation_sum
  CHECK (package_price_cents IS NULL OR (direct_max_cents + growth_allocation_cents = package_price_cents));

-- ── 2. marketing_allocations: per-job internal ceiling accounting (DB-enforced) ─────
-- The authoritative ceiling record. reserved + spent can NEVER exceed direct_max (DB CHECK + conditional
-- UPDATEs in the service). NO seller_user_id — this is Advantage.Bid's own money.
CREATE TABLE IF NOT EXISTS marketing_allocations (
  marketing_job_id     UUID PRIMARY KEY REFERENCES marketing_jobs(id) ON DELETE CASCADE,
  auction_id           UUID REFERENCES auctions(id) ON DELETE SET NULL,
  package_price_cents  INTEGER NOT NULL CHECK (package_price_cents >= 0),
  direct_max_cents     INTEGER NOT NULL CHECK (direct_max_cents >= 0),
  growth_base_cents    INTEGER NOT NULL CHECK (growth_base_cents >= 0),
  direct_reserved_cents INTEGER NOT NULL DEFAULT 0 CHECK (direct_reserved_cents >= 0),
  direct_spent_cents    INTEGER NOT NULL DEFAULT 0 CHECK (direct_spent_cents >= 0),
  unused_swept          BOOLEAN NOT NULL DEFAULT false,   -- unused capacity → Growth contributed EXACTLY once
  allocation_model_version TEXT NOT NULL DEFAULT 'v1',
  frozen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_alloc_ceiling CHECK (direct_reserved_cents + direct_spent_cents <= direct_max_cents),
  CONSTRAINT chk_alloc_sum     CHECK (direct_max_cents + growth_base_cents = package_price_cents)
);

-- ── 3. marketing_ledger: append-only internal direct-marketing ledger (NO seller_user_id) ─
CREATE TABLE IF NOT EXISTS marketing_ledger (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marketing_job_id UUID NOT NULL REFERENCES marketing_jobs(id) ON DELETE CASCADE,
  entry_type       TEXT NOT NULL CHECK (entry_type IN ('ALLOCATION','RESERVATION','SPEND','RELEASE')),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  reservation_id   UUID,                         -- groups RESERVATION → SPEND/RELEASE
  idempotency_key  TEXT NOT NULL UNIQUE,         -- retry-safe: a repeated op writes no second row
  campaign_id      UUID,
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: intentionally NO seller identity column (accounting separation, enforced by test).
);
CREATE INDEX IF NOT EXISTS idx_marketing_ledger_job ON marketing_ledger(marketing_job_id);

-- ── 4. Growth Pool: singleton balance + append-only ledger + monthly authority ──────
CREATE TABLE IF NOT EXISTS growth_pool (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- singleton
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO growth_pool (id, balance_cents) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS growth_pool_ledger (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type       TEXT NOT NULL CHECK (entry_type IN
                     ('BASE_CONTRIBUTION','UNUSED_CAPACITY_CONTRIBUTION','SPEND','RELEASE','ADDITIONAL_AUTHORITY_SPEND','OWNER_GRANT')),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
  marketing_job_id UUID REFERENCES marketing_jobs(id) ON DELETE SET NULL,
  market_id        UUID,
  campaign_id      UUID,
  occurred_month   DATE NOT NULL DEFAULT date_trunc('month', now())::date,
  idempotency_key  TEXT NOT NULL UNIQUE,
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: intentionally NO seller identity column (internal money).
);
CREATE INDEX IF NOT EXISTS idx_growth_ledger_month ON growth_pool_ledger(occurred_month);

-- Monthly autonomous-authority snapshot (spend beyond accumulated pool, capped by config + owner grants).
CREATE TABLE IF NOT EXISTS growth_monthly_authority (
  month                      DATE PRIMARY KEY,                 -- first of month
  additional_authority_cents INTEGER NOT NULL,                 -- snapshot of config ceiling for the month
  owner_granted_cents        INTEGER NOT NULL DEFAULT 0,       -- separately recorded owner-approved additions
  spent_beyond_pool_cents    INTEGER NOT NULL DEFAULT 0 CHECK (spent_beyond_pool_cents >= 0),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_growth_month_authority CHECK (spent_beyond_pool_cents <= additional_authority_cents + owner_granted_cents)
);

-- ── 5. Growth markets (configurable; NOT hard-coded into campaign logic) ─────────────
CREATE TABLE IF NOT EXISTS growth_markets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  priority    INTEGER NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO growth_markets (name, slug, priority) VALUES
  ('Houston Metropolitan Area', 'houston-metro', 10),
  ('New York City Metropolitan Area', 'nyc-metro', 20)
ON CONFLICT (slug) DO NOTHING;

-- ── 6. Campaign lifecycle + resolved radius + explicit exceptions ───────────────────
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marketing_job_id    UUID REFERENCES marketing_jobs(id) ON DELETE SET NULL,  -- null for brand/growth campaigns
  auction_id          UUID REFERENCES auctions(id) ON DELETE SET NULL,
  campaign_class      TEXT NOT NULL CHECK (campaign_class IN ('event_local','buyer','seller','professional_seller','brand','growth')),
  state               TEXT NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft','queued','qa_pending','qa_passed','qa_failed','published','executing','completed','cancelled','escalated')),
  resolved_radius_miles INTEGER,                 -- required for event_local (30 default) — must be set for paid event_local
  radius_exception_id UUID,
  event_lat           DOUBLE PRECISION,          -- real event coordinates (required for paid event_local)
  event_lng           DOUBLE PRECISION,
  market_id           UUID REFERENCES growth_markets(id) ON DELETE SET NULL,  -- for growth-market campaigns
  is_paid             BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_job ON marketing_campaigns(marketing_job_id);

CREATE TABLE IF NOT EXISTS marketing_radius_exceptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  radius_miles INTEGER NOT NULL CHECK (radius_miles > 0),
  reason       TEXT NOT NULL,
  approved_by  UUID REFERENCES users(id) ON DELETE SET NULL,   -- explicit human/owner authorization
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 7. Creative provenance + QA (mirrors lot_ai_verifications provenance pattern) ────
CREATE TABLE IF NOT EXISTS marketing_creative_assets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  asset_type     TEXT NOT NULL,                 -- 'image' | 'copy' | 'video' | ...
  content        TEXT,
  content_url    TEXT,
  source_lot_id  UUID,                          -- traceability to the originating lot (kept even after close/archive)
  source_auction_id UUID,
  generator      TEXT,                          -- model/tool provenance (internal only)
  prompt_version TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_creative_claims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id          UUID NOT NULL REFERENCES marketing_creative_assets(id) ON DELETE CASCADE,
  claim_text        TEXT NOT NULL,
  claim_kind        TEXT NOT NULL DEFAULT 'factual' CHECK (claim_kind IN ('factual','subjective','implied')),
  authoritative_source TEXT,                    -- factual claims REQUIRE a non-null source (enforced in service + QA)
  source_ref        JSONB,                      -- e.g. {lot_id, field}
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_creative_variants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    UUID NOT NULL REFERENCES marketing_creative_assets(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL,
  content     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_qa_reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  asset_id     UUID REFERENCES marketing_creative_assets(id) ON DELETE CASCADE,
  review_type  TEXT NOT NULL,                   -- 'deterministic' | 'judgment'
  outcome      TEXT NOT NULL CHECK (outcome IN ('pass','fail','needs_review')),
  findings     JSONB,
  reviewer     TEXT,                            -- agent service identity or 'deterministic'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 8. Durable transactional job queue (outbox — participates in the caller's tx) ────
CREATE TABLE IF NOT EXISTS marketing_job_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type        TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','done','failed','dead')),
  idempotency_key TEXT UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  last_error      TEXT,
  run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_queue_ready ON marketing_job_queue(state, run_after);

-- ── 9. Agent registry + capabilities (service identities, least privilege) ───────────
CREATE TABLE IF NOT EXISTS marketing_agents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key     TEXT NOT NULL UNIQUE,           -- e.g. 'marketing_director', 'specialist_copy', 'qa'
  display_name  TEXT NOT NULL,
  capabilities  JSONB NOT NULL DEFAULT '[]',    -- least-privilege capability grants
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO marketing_agents (agent_key, display_name, capabilities) VALUES
  ('marketing_director', 'Marketing Director', '["plan","allocate","growth_spend","escalate"]'),
  ('specialist_copy',    'Copy Specialist',    '["draft_creative"]'),
  ('specialist_media',   'Media Specialist',   '["draft_creative"]'),
  ('qa',                 'Independent QA',      '["review","approve_release","reject_release"]')
ON CONFLICT (agent_key) DO NOTHING;

-- ── 10. Centralized marketing.* config (runtime-tunable business values) ─────────────
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.direct_spend_max_bps',                     '6000'::jsonb,  'marketing'),
  ('marketing.event_local_radius_miles',                 '30'::jsonb,    'marketing'),
  ('marketing.growth_monthly_additional_authority_cents','100000'::jsonb,'marketing'),
  ('marketing.qa_required_before_release',               'true'::jsonb,  'marketing'),
  ('marketing.factual_source_required',                  'true'::jsonb,  'marketing'),
  ('marketing.autonomous_release.organic',               'true'::jsonb,  'marketing'),
  ('marketing.autonomous_release.paid',                  'true'::jsonb,  'marketing'),
  ('marketing.full_circle_required',                     'true'::jsonb,  'marketing'),
  ('marketing.qa_max_cycles',                            '3'::jsonb,     'marketing')
ON CONFLICT (key) DO NOTHING;
