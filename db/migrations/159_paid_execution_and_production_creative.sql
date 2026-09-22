-- 159_paid_execution_and_production_creative.sql — ADDITIVE + idempotent.
--
-- Three things the Marketing Agency was missing before it could run real campaigns:
--
--   1. A PRODUCTION CREATIVE REGISTRY. The filesystem is not an approval system. Owner approval,
--      production eligibility and factual-validation state have to be recorded facts, so that
--      "may this image be paid for?" has an answer that does not depend on which folder somebody
--      dragged a file into next.
--
--   2. A BUDGET LEDGER with committed-vs-actual separation. Caps that are only checked while
--      PLANNING cannot stop overspend; money is committed at creation and spent afterwards, so the
--      ceiling has to be enforced against both, under a lock, with idempotency.
--
--   3. CAMPAIGN EXECUTION RECORDS + KILL SWITCHES. Something durable to create, observe, pause and
--      stop — and a single switch that stops everything regardless of per-channel state.
--
-- Deliberately NOT done here: nothing is enabled. Every gate this migration introduces ships OFF,
-- no campaign is created, no creative is approved beyond the Owner's own grandfathered placement,
-- and no provider is contacted.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Production creative registry.
-- ---------------------------------------------------------------------------------------------
-- One row per production-creative image. `owner_approved_for_production` is the Owner's decision;
-- `production_eligible` is the runtime's answer, which additionally requires that factual
-- validation is clear. They are separate columns ON PURPOSE: an Owner approval must never be
-- silently converted into permission to publish something that is factually wrong today.
CREATE TABLE IF NOT EXISTS marketing_production_creative (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_key               text        NOT NULL UNIQUE,          -- stable id, derived from sha256
  sha256                  text        NOT NULL,
  filename                text        NOT NULL,
  relative_path           text        NOT NULL UNIQUE,          -- relative to the production-creative root
  category                text        NOT NULL,
  campaign_purpose        text,                                 -- what this ad is for (UNKNOWN when not stated)
  audience                text,
  destination_type        text,                                 -- 'buyer_discovery' | 'seller_landing' | ...
  evergreen               boolean,                              -- NULL = unknown; true = not tied to one event
  -- Owner decision
  owner_approved_for_production boolean NOT NULL DEFAULT false,
  approval_source         text,                                 -- 'grandfathered_owner_placement' | 'owner_review' | ...
  approval_recorded_at    timestamptz,
  -- Runtime answer
  production_eligible     boolean     NOT NULL DEFAULT false,
  ineligible_reason       text,
  -- Provenance + validation
  provenance              text,                                 -- 'OWNER_APPROVED_PRODUCTION' | 'GENERATED_CANDIDATE' | ...
  provenance_conflict     text,                                 -- set when the asset's own sidecar disagrees with its folder
  factual_requirements    jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- what must be true before this may run
  associated_auction_id   uuid        REFERENCES auctions(id) ON DELETE SET NULL,
  associated_event_id     uuid        REFERENCES events(id) ON DELETE SET NULL,
  associated_lot_id       uuid,
  width                   integer,
  height                  integer,
  status                  text        NOT NULL DEFAULT 'REGISTERED',
  registered_at           timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mpc_category CHECK (category IN (
    'auction','auction-event','buyer-acquisition','buyer-growth','do-not-use','estate-sale',
    'geographic-event','individual-seller','notable-lot','professional-seller')),
  CONSTRAINT chk_mpc_status CHECK (status IN ('REGISTERED','RETIRED','SUPERSEDED')),
  -- A do-not-use asset can never be approved or eligible. Enforced by the database, not by hope.
  CONSTRAINT chk_mpc_do_not_use_never_approved CHECK (
    category <> 'do-not-use' OR (owner_approved_for_production = false AND production_eligible = false)),
  -- Eligibility can never exceed approval.
  CONSTRAINT chk_mpc_eligible_requires_approval CHECK (
    production_eligible = false OR owner_approved_for_production = true)
);
CREATE INDEX IF NOT EXISTS idx_mpc_category ON marketing_production_creative(category);
CREATE INDEX IF NOT EXISTS idx_mpc_eligible ON marketing_production_creative(production_eligible) WHERE production_eligible = true;

-- ---------------------------------------------------------------------------------------------
-- 2. Budget ledger — committed vs actual, per month.
-- ---------------------------------------------------------------------------------------------
-- The month row is the serialization point: every reservation takes SELECT ... FOR UPDATE on it,
-- so two concurrent creations cannot both read the same remaining authority and both spend it.
CREATE TABLE IF NOT EXISTS marketing_paid_budget_months (
  month           date        PRIMARY KEY,           -- first of month
  ceiling_cents   integer     NOT NULL,
  committed_cents integer     NOT NULL DEFAULT 0,
  actual_cents    integer     NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mpbm_nonneg CHECK (committed_cents >= 0 AND actual_cents >= 0),
  -- The hard ceiling, enforced by the database. No application bug can write past it.
  CONSTRAINT chk_mpbm_within_ceiling CHECK (committed_cents <= ceiling_cents)
);

-- Append-only entries. `idempotency_key` is what makes a retried campaign creation safe: the same
-- key can never commit twice.
CREATE TABLE IF NOT EXISTS marketing_paid_budget_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month           date        NOT NULL,
  campaign_key    text,
  kind            text        NOT NULL,
  amount_cents    integer     NOT NULL,
  idempotency_key text        NOT NULL UNIQUE,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mpbl_kind CHECK (kind IN ('commit','release','actual'))
);
CREATE INDEX IF NOT EXISTS idx_mpbl_month ON marketing_paid_budget_ledger(month);
CREATE INDEX IF NOT EXISTS idx_mpbl_campaign ON marketing_paid_budget_ledger(campaign_key);

-- ---------------------------------------------------------------------------------------------
-- 3. Campaign execution records.
-- ---------------------------------------------------------------------------------------------
-- The durable object the Director creates, observes, pauses and stops. Provider ids are recorded
-- when (and only when) a provider actually accepts the campaign.
CREATE TABLE IF NOT EXISTS marketing_paid_campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_key          text        NOT NULL UNIQUE,
  proposal_id           uuid        REFERENCES marketing_paid_growth_proposals(id) ON DELETE SET NULL,
  channel               text        NOT NULL,
  objective             text        NOT NULL,
  funnel                text        NOT NULL,        -- 'buyer' | 'individual_seller' | 'professional_seller'
  market                text,
  audience              text,
  destination_url       text,
  creative_id           uuid        REFERENCES marketing_production_creative(id) ON DELETE RESTRICT,
  budget_cents          integer     NOT NULL DEFAULT 0,
  daily_budget_cents    integer,
  state                 text        NOT NULL DEFAULT 'PLANNED',
  blocked_reason        text,
  provider_account_ref  text,
  provider_campaign_id  text,
  provider_adset_id     text,
  provider_ad_id        text,
  idempotency_key       text        UNIQUE,
  last_error            text,
  evidence              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz,
  paused_at             timestamptz,
  stopped_at            timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mpcam_state CHECK (state IN (
    'PLANNED','CREATIVE_BLOCKED','READY','ACTIVE','PAUSED','STOPPED','FAILED')),
  CONSTRAINT chk_mpcam_funnel CHECK (funnel IN ('buyer','individual_seller','professional_seller')),
  -- An ACTIVE campaign must name the creative it is running and the provider object it became.
  CONSTRAINT chk_mpcam_active_is_complete CHECK (
    state <> 'ACTIVE' OR (creative_id IS NOT NULL AND provider_campaign_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_mpcam_state ON marketing_paid_campaigns(state);

-- ---------------------------------------------------------------------------------------------
-- 4. Gates. Every one ships OFF / safe.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform_config (key, value, category) VALUES
  -- The single switch that stops all paid execution regardless of any other setting.
  ('marketing.paid.global_kill', 'false', 'marketing'),
  -- The master gate for paid execution. Separate from the per-channel destination gates.
  ('marketing.paid.execution_enabled', 'false', 'marketing'),
  -- Per-campaign and per-day ceilings, under the monthly authority.
  ('marketing.paid_growth.campaign_ceiling_usd', '400', 'marketing'),
  ('marketing.paid_growth.daily_ceiling_usd', '50', 'marketing'),
  -- Production creative: which filesystem root is authoritative, and whether presence implies
  -- approval. Presence NEVER implies approval after the initial grandfathering.
  ('marketing.production_creative.filesystem_presence_implies_approval', 'false', 'marketing'),
  ('marketing.production_creative.grandfathered_at', 'null', 'marketing')
ON CONFLICT (key) DO NOTHING;

COMMIT;
