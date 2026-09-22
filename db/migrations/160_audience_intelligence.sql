-- 160_audience_intelligence.sql — ADDITIVE + idempotent.
--
-- The Marketing Director could say "run an Individual Seller campaign in Houston" but had nowhere
-- to record WHICH audience it was testing, WHY, what Meta was actually told to target, or what the
-- result taught it. Campaign rows carried a free-text `audience` string and nothing else: no
-- provider ids, no validation state, no reach, no history. This is that missing layer.
--
-- WHY PROVIDER IDS ARE STORED, NOT LABELS. Discovery against the live API proved the danger of
-- human-readable targeting:
--   * Searching "Estate sale" returns REAL ESTATE interests — a completely different audience that
--     merely sounds right.
--   * "Estate liquidation" [6003460205425] IS returned by interest search but is NOT usable by this
--     ad account: targetingvalidation reports valid=false and a reach estimate errors outright.
--   * An invented id (9999999999999) is reported invalid by targetingvalidation, but a reach
--     estimate silently returns 0–0 rather than failing.
-- So a strategy is only usable once every provider id in it has been validated by the provider, and
-- validation has to be re-run rather than trusted forever.
--
-- BUDGET IS NEVER MULTIPLIED. Audience variants SHARE a campaign's authorized budget: the sum of a
-- campaign's variant allocations may not exceed the campaign, which is itself already bounded by the
-- per-campaign, daily and monthly ceilings. Testing three audiences must cost the same as testing
-- one.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Audience strategies — a hypothesis plus the exact provider specification that tests it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_audience_strategies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_key          text        NOT NULL UNIQUE,
  funnel                text        NOT NULL,
  provider              text        NOT NULL DEFAULT 'meta',
  -- The business reasoning, in the Owner's language.
  hypothesis            text        NOT NULL,
  rationale             text,
  -- The exact thing the provider is told. Ids, never labels.
  targeting_spec        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  geography             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  inclusions            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  exclusions            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  optimization_goal     text,
  audience_mode         text,       -- 'broad' | 'advantage_plus' | 'detailed' | 'custom' | 'lookalike'
  -- Provider validation. A strategy is unusable until every id in it validates.
  validation_state      text        NOT NULL DEFAULT 'UNVALIDATED',
  validation_detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_validated_at     timestamptz,
  estimated_reach_lower bigint,
  estimated_reach_upper bigint,
  reach_estimated_at    timestamptz,
  -- Director state machine.
  learning_state        text        NOT NULL DEFAULT 'NO_DATA',
  director_confidence   numeric(4,3),
  policy_status         text        NOT NULL DEFAULT 'OK',
  policy_detail         text,
  provenance            text,
  active                boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mas_funnel CHECK (funnel IN ('buyer','individual_seller','professional_seller')),
  CONSTRAINT chk_mas_validation CHECK (validation_state IN ('UNVALIDATED','VALID','PARTIAL','INVALID','PROVIDER_UNAVAILABLE')),
  CONSTRAINT chk_mas_learning CHECK (learning_state IN (
    'NO_DATA','INSUFFICIENT_DATA','PROMISING','UNDERPERFORMING','POLICY_BLOCKED','PROVIDER_UNAVAILABLE','RETIRED')),
  CONSTRAINT chk_mas_policy CHECK (policy_status IN ('OK','BLOCKED')),
  -- A strategy may only be active when the provider has confirmed it and policy allows it.
  CONSTRAINT chk_mas_active_requires_valid CHECK (
    active = false OR (validation_state = 'VALID' AND policy_status = 'OK'))
);
CREATE INDEX IF NOT EXISTS idx_mas_funnel ON marketing_audience_strategies(funnel);
CREATE INDEX IF NOT EXISTS idx_mas_active ON marketing_audience_strategies(active) WHERE active = true;

-- ---------------------------------------------------------------------------------------------
-- 2. Audience experiments — variants that SHARE one campaign's authorized budget.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_audience_experiments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_key        text        NOT NULL UNIQUE,
  campaign_key          text        NOT NULL REFERENCES marketing_paid_campaigns(campaign_key) ON DELETE CASCADE,
  funnel                text        NOT NULL,
  -- The campaign's authorized budget. Variant allocations are checked against THIS, never added to it.
  campaign_budget_cents integer     NOT NULL,
  state                 text        NOT NULL DEFAULT 'PLANNED',
  hypothesis            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mae_state CHECK (state IN ('PLANNED','RUNNING','PAUSED','CONCLUDED','ABANDONED'))
);

CREATE TABLE IF NOT EXISTS marketing_audience_experiment_arms (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id         uuid        NOT NULL REFERENCES marketing_audience_experiments(id) ON DELETE CASCADE,
  strategy_id           uuid        NOT NULL REFERENCES marketing_audience_strategies(id) ON DELETE RESTRICT,
  arm_label             text        NOT NULL,
  allocated_cents       integer     NOT NULL,
  provider_adset_id     text,
  -- Observed facts, one row per arm so the funnels can be compared honestly.
  spend_cents           integer     NOT NULL DEFAULT 0,
  impressions           integer     NOT NULL DEFAULT 0,
  clicks                integer     NOT NULL DEFAULT 0,
  landing_visits        integer     NOT NULL DEFAULT 0,
  registrations         integer     NOT NULL DEFAULT 0,
  qualified_conversions integer     NOT NULL DEFAULT 0,
  downstream_value_cents integer,
  last_observed_at      timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, arm_label),
  CONSTRAINT chk_maea_alloc CHECK (allocated_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_maea_strategy ON marketing_audience_experiment_arms(strategy_id);

-- ---------------------------------------------------------------------------------------------
-- 3. Durable audience learning, so a failed audience is not rediscovered every week.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_audience_learnings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id       uuid        REFERENCES marketing_audience_strategies(id) ON DELETE SET NULL,
  strategy_key      text        NOT NULL,
  funnel            text        NOT NULL,
  observed_state    text        NOT NULL,
  decision          text        NOT NULL,
  reason            text        NOT NULL,
  evidence          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sample_sufficient boolean     NOT NULL DEFAULT false,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mal_decision CHECK (decision IN (
    'CONTINUE','REDUCE','PAUSE','RETIRE','RETEST','EXPAND_GEOGRAPHY','CREATE_RELATED_HYPOTHESIS','HOLD'))
);
CREATE INDEX IF NOT EXISTS idx_mal_strategy_key ON marketing_audience_learnings(strategy_key);

-- ---------------------------------------------------------------------------------------------
-- 4. Config. Audience intelligence introduces NO new spending authority.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform_config (key, value, category) VALUES
  -- Provider capability must be re-checked, never assumed permanent.
  ('marketing.audience.validation_max_age_days', '30', 'marketing'),
  -- First-party audience upload to a provider stays OFF until the Owner approves it separately.
  ('marketing.audience.first_party_upload_enabled', 'false', 'marketing'),
  -- Minimum observations before any audience may be called better or worse than another.
  ('marketing.audience.min_landing_visits_for_signal', '100', 'marketing'),
  ('marketing.audience.min_conversions_for_signal', '5', 'marketing')
ON CONFLICT (key) DO NOTHING;

COMMIT;
