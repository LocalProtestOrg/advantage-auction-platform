-- 130_growth_lab_4b.sql — Autonomous Growth Lab (Phase 4B): experiment safety + durable learning.
-- ADDITIVE / idempotent / non-destructive. EXTENDS the certified 4A marketing_experiments + growth_pool
-- (NO second experiment table, NO second Growth Pool). Nothing external is activated by this migration.

-- ── 1. Pre-registration + conditions/baseline + design/verdict/portfolio on the 4A experiments table ──
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS preregistration       JSONB;        -- frozen fields
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS prereg_hash           TEXT;         -- deterministic hash
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS prereg_frozen_at      TIMESTAMPTZ;
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS execution_started_at  TIMESTAMPTZ;  -- immutability boundary
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS conditions            JSONB;        -- world the experiment ran in
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS baseline              JSONB;        -- captured BEFORE execution
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS design                JSONB;        -- MDE/required-exposure output
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS design_status         TEXT;         -- adequately_powered|underpowered_experiment|insufficient_baseline|insufficient_audience
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS attribution_grade     TEXT CHECK (attribution_grade IN ('experimental','quasi_experimental','tracked','correlational') OR attribution_grade IS NULL);
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS verdict               TEXT CHECK (verdict IN ('positive','negative','inconclusive','no_conclusion_yet','invalidated') OR verdict IS NULL);
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS band                  TEXT CHECK (band IN ('proven','incremental','exploratory','novel') OR band IS NULL);
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS rung                  INTEGER;       -- 0..4 ladder
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS analysis_window_days  INTEGER;      -- frozen at prereg
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS hypothesis_family     TEXT;         -- retry/retirement similarity key
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS supersedes_experiment_id UUID REFERENCES marketing_experiments(id) ON DELETE SET NULL;
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS stop_reason           TEXT;
ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS stopped_at            TIMESTAMPTZ;

-- ── 2. Growth Pool RESERVATION lifecycle (extends the certified pool; NO second pool) ──
ALTER TABLE growth_pool ADD COLUMN IF NOT EXISTS reserved_cents BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0);
-- extend the ledger vocabulary with reservation entries (drop the auto-named column check, re-add widened)
ALTER TABLE growth_pool_ledger DROP CONSTRAINT IF EXISTS growth_pool_ledger_entry_type_check;
ALTER TABLE growth_pool_ledger ADD CONSTRAINT growth_pool_ledger_entry_type_check
  CHECK (entry_type IN ('BASE_CONTRIBUTION','UNUSED_CAPACITY_CONTRIBUTION','SPEND','RELEASE','ADDITIONAL_AUTHORITY_SPEND','OWNER_GRANT','RESERVATION','RESERVATION_RELEASE'));

CREATE TABLE IF NOT EXISTS growth_pool_reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   UUID REFERENCES marketing_experiments(id) ON DELETE SET NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  spent_cents     INTEGER NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  month           DATE NOT NULL DEFAULT date_trunc('month', now())::date,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','spent','released')),
  idempotency_key TEXT NOT NULL UNIQUE,          -- cannot reserve the same authority twice
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_growth_res_spend CHECK (spent_cents <= amount_cents)
);
CREATE INDEX IF NOT EXISTS idx_growth_reservations_active ON growth_pool_reservations(status) WHERE status = 'active';

-- ── 3. Durable learning memory (verdicts + scope + supersession) ─────────────────────
CREATE TABLE IF NOT EXISTS marketing_learnings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement                 TEXT NOT NULL,
  scope                     TEXT NOT NULL CHECK (scope IN ('market_specific','category_specific','segment_specific','general')),
  market_id                 UUID REFERENCES growth_markets(id) ON DELETE SET NULL,
  category                  TEXT,
  segment                   TEXT,
  verdict                   TEXT NOT NULL CHECK (verdict IN ('positive','negative','inconclusive','no_conclusion_yet','invalidated')),
  confidence                TEXT,
  attribution_grade         TEXT CHECK (attribution_grade IN ('experimental','quasi_experimental','tracked','correlational') OR attribution_grade IS NULL),
  supporting_experiment_ids JSONB NOT NULL DEFAULT '[]',
  contradicting_experiment_ids JSONB NOT NULL DEFAULT '[]',
  invalidating_conditions   JSONB NOT NULL DEFAULT '[]',
  valid_as_of               TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by             UUID REFERENCES marketing_learnings(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_learnings_scope ON marketing_learnings(scope, market_id, category, segment);

-- ── 4. Signal source registry (data-driven; seed ONLY genuinely-supported signals) ───
CREATE TABLE IF NOT EXISTS marketing_signal_sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key  TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL,                      -- marketplace|auction|category|geographic|buyer_funnel|seller_funnel|campaign|crm|channel|audience|experiment_history
  description TEXT,
  is_live     BOOLEAN NOT NULL DEFAULT false,     -- only true where the signal is actually populated today
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO marketing_signal_sources (source_key, category, description, is_live) VALUES
  ('auction.gross_revenue',      'auction',          'Auction hammer/gross from settlement data', true),
  ('auction.sold_ratio',         'auction',          'Sold lots / total valid lots', true),
  ('auction.unique_buyers',      'auction',          'Unique winning buyers per auction', true),
  ('marketplace.active_auctions','marketplace',      'Count of active/published auctions', true),
  ('crm.prospect_pipeline',      'crm',              'Sales prospect pipeline counts', true),
  ('experiment.history',         'experiment_history','Prior experiments + verdicts + learnings', true),
  ('geographic.growth_markets',  'geographic',       'Configured Growth priority markets', true),
  ('channel.email_engagement',   'channel',          'Email open/click (NOT live — provider tracking deferred)', false),
  ('audience.purchased',         'audience',         'Purchased audience datasets (NOT live)', false)
ON CONFLICT (source_key) DO NOTHING;

-- ── 5. Config: objective-specific attribution windows + portfolio band ceilings + email invariant ────
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.windows.buyer_days',                '14'::jsonb, 'marketing'),
  ('marketing.windows.individual_seller_days',    '45'::jsonb, 'marketing'),
  ('marketing.windows.professional_seller_days',  '90'::jsonb, 'marketing'),
  ('marketing.windows.auction_days',              '21'::jsonb, 'marketing'),
  ('marketing.portfolio.exploratory_max_share_bps', '2500'::jsonb, 'marketing'),  -- ceiling, NEVER a quota
  ('marketing.portfolio.novel_max_share_bps',       '1000'::jsonb, 'marketing'),  -- ceiling, NEVER a quota
  ('marketing.email.audience_rules_locked',       'true'::jsonb, 'marketing')     -- underpowered email may NEVER weaken permission/suppression/eligibility
ON CONFLICT (key) DO NOTHING;
