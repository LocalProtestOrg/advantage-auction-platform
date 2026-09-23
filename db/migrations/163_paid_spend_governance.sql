-- 163_paid_spend_governance.sql — ADDITIVE + idempotent.
--
-- The first live Meta experiment exposed three gaps in paid-growth budget governance:
--
--   1. Provider spend never reached the budget ledger. Meta had spent $83.50 while the internal
--      "actual" figure read $0.00, so every authority decision was being made against a number
--      that was known to be wrong.
--   2. "$50/day" was presented as a limit. It is not: a Meta ad-set daily budget is a pacing TARGET
--      that the provider may exceed on any single day. The monthly $1,000 is the Owner's real
--      authority, and at $50/day a 30-day month would imply $1,500 — the two could never both hold.
--   3. Nothing described WHERE money was being spent, so a second market (NYC) could not be added
--      without either mixing its results into Houston or implying it had a budget of its own.
--
-- This migration adds the durable records the repair needs. It moves no money and changes no live
-- campaign: the Houston campaigns keep their $135 authorizations and their provider spend caps.
--
--   marketing_paid_markets        one row per geography. Markets SHARE the global monthly ceiling;
--                                 there is deliberately no per-market ceiling column, so a market
--                                 cannot create authority. `allocation_cents` is a soft split of the
--                                 SAME global money and is checked against it in code.
--   marketing_paid_spend_syncs    every provider spend read, successful or not — the freshness and
--                                 reconciliation evidence the Owner and the Director both rely on.
--   ledger audit columns          which provider campaign and which provider day an 'actual' entry
--                                 came from, so a figure can always be traced back to Meta.
--   is_internal flags             the Owner's own subscription and conversion stay in the database
--                                 but leave acquisition reporting, CAC and growth counts.
--   user_agent_class              a coarse browser/crawler class on attribution touches, so provider
--                                 review crawls stop inflating paid landing visits. The raw user
--                                 agent is never stored.

BEGIN;

-- ── 1. Markets ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_paid_markets (
  market_key         text PRIMARY KEY,
  name               text        NOT NULL,
  provider           text        NOT NULL DEFAULT 'meta',
  -- Provider-resolved geography. Never guessed: filled by a provider lookup and validated with a
  -- provider delivery estimate before a market may be launched.
  geo_spec           jsonb,
  geo_validation     text        NOT NULL DEFAULT 'UNVALIDATED',
  geo_evidence       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  geo_validated_at   timestamptz,
  status             text        NOT NULL DEFAULT 'PREPARED',
  -- The Owner's decision to allow paid delivery in this market. Nothing sets this automatically.
  launch_authorized  boolean     NOT NULL DEFAULT false,
  launch_authorized_at timestamptz,
  -- Optional soft split of the ONE global monthly ceiling. NULL = no market-level split.
  allocation_cents   integer,
  plan               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_mpm_status CHECK (status IN ('PREPARED','ACTIVE','PAUSED','RETIRED')),
  CONSTRAINT chk_mpm_geo_validation CHECK (geo_validation IN ('UNVALIDATED','VALID','INVALID')),
  CONSTRAINT chk_mpm_allocation CHECK (allocation_cents IS NULL OR allocation_cents >= 0),
  -- A market cannot be live without a validated geography and an explicit Owner authorization.
  CONSTRAINT chk_mpm_active_requires_authority CHECK (
    status <> 'ACTIVE' OR (launch_authorized = true AND geo_validation = 'VALID'))
);

-- Houston is the market the first experiment already runs in. Its geography (Meta city key
-- 2527622, 25 mile radius) was provider-validated when the experiment's audience strategies were
-- built (migration 160 / audienceIntelligenceService.HOUSTON_METRO).
INSERT INTO marketing_paid_markets (market_key, name, geo_spec, geo_validation, geo_evidence,
  geo_validated_at, status, launch_authorized, launch_authorized_at, notes)
VALUES ('houston', 'Houston Metro',
  '{"geo_locations":{"cities":[{"key":"2527622","radius":25,"distance_unit":"mile"}]},"label":"Houston, Texas (25 mi)"}'::jsonb,
  'VALID',
  '{"source":"audience_intelligence_strategies","note":"validated with the first Houston experiment strategies"}'::jsonb,
  now(), 'ACTIVE', true, now(),
  'First seller acquisition experiment market (2026-09).')
ON CONFLICT (market_key) DO NOTHING;

-- NYC is PREPARED only. Its geography is resolved and validated against the provider by
-- scripts/prepare-nyc-market.js; until then it is UNVALIDATED and cannot launch.
INSERT INTO marketing_paid_markets (market_key, name, status, launch_authorized, notes)
VALUES ('nyc', 'New York City', 'PREPARED', false,
  'Next seller acquisition market. Shares the global monthly ceiling; creates no new authority.')
ON CONFLICT (market_key) DO NOTHING;

ALTER TABLE marketing_paid_campaigns ADD COLUMN IF NOT EXISTS market_key text
  REFERENCES marketing_paid_markets(market_key);
UPDATE marketing_paid_campaigns SET market_key = 'houston'
 WHERE market_key IS NULL AND market = 'Houston Metro';

-- ── 2. Spend sync evidence ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_paid_spend_syncs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text        NOT NULL DEFAULT 'meta',
  account_ref           text,
  trigger               text        NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  ok                    boolean     NOT NULL DEFAULT false,
  window_since          date,
  window_until          date,
  month                 date,
  provider_month_cents  bigint,
  internal_month_cents  bigint,
  provider_campaigns    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ledger_entries        integer     NOT NULL DEFAULT 0,
  arms_updated          integer     NOT NULL DEFAULT 0,
  reconciliation_state  text,
  flags                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
  actions               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error                 text
);
CREATE INDEX IF NOT EXISTS idx_mpss_finished ON marketing_paid_spend_syncs (finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_mpss_ok_finished ON marketing_paid_spend_syncs (ok, finished_at DESC);

ALTER TABLE marketing_paid_budget_ledger ADD COLUMN IF NOT EXISTS provider_campaign_id text;
ALTER TABLE marketing_paid_budget_ledger ADD COLUMN IF NOT EXISTS fact_date date;
ALTER TABLE marketing_paid_budget_ledger ADD COLUMN IF NOT EXISTS sync_id uuid;
CREATE INDEX IF NOT EXISTS idx_mpbl_actual_day
  ON marketing_paid_budget_ledger (provider_campaign_id, fact_date) WHERE kind = 'actual';

-- ── 3. Internal (Owner / staff) records stay, but leave acquisition reporting ─────────────────
ALTER TABLE marketing_contacts ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;
ALTER TABLE marketing_contacts ADD COLUMN IF NOT EXISTS internal_reason text;
ALTER TABLE marketing_contacts ADD COLUMN IF NOT EXISTS internal_marked_at timestamptz;
ALTER TABLE marketing_conversion_events ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

-- The 2026-09-22 Jersey City subscription was made by the Owner (linked account is the Super
-- Admin) before any paid campaign ran. It is NOT an acquired subscriber. The subscription itself is
-- preserved; only its reporting classification changes. Matched by id, never by address.
UPDATE marketing_contacts
   SET is_internal = true, internal_reason = 'owner_account', internal_marked_at = now()
 WHERE id = '28904056-bf01-4438-86c0-167a72da1b02' AND is_internal = false;

-- Any conversion that belongs to an internal contact or an internal (admin / staff) user.
UPDATE marketing_conversion_events e SET is_internal = true
  FROM marketing_contacts mc
 WHERE mc.is_internal = true AND e.is_internal = false
   AND e.subject_type = 'subscriber_email_sha256'
   AND e.subject_id = encode(sha256(convert_to(lower(mc.normalized_email), 'UTF8')), 'hex');

-- ── 4. Touch user-agent class (never the raw agent) ──────────────────────────────────────────
ALTER TABLE marketing_attribution_touches ADD COLUMN IF NOT EXISTS user_agent_class text;

-- ── 5. Governance configuration (Super Admin editable) ───────────────────────────────────────
INSERT INTO platform_config (key, value, category) VALUES
  -- Month boundaries and "today" follow the ad account's own reporting timezone.
  ('marketing.paid.pacing.timezone', '"America/New_York"', 'marketing'),
  -- Configured provider daily budgets may total at most this share of the safe daily pacing
  -- target, leaving room for provider pacing variance.
  ('marketing.paid.pacing.daily_budget_safety_factor', '0.75', 'marketing'),
  -- Meta's documented worst case: a single day may spend up to 75% above the daily budget.
  ('marketing.paid.pacing.provider_max_daily_overdelivery', '1.75', 'marketing'),
  -- How often live spend is re-read from the provider while anything is ACTIVE.
  ('marketing.paid.spend_sync.interval_minutes', '60', 'marketing'),
  -- Older than this, spend data is STALE for monitoring purposes.
  ('marketing.paid.spend_sync.max_age_minutes', '120', 'marketing'),
  -- A spending DECISION needs data at most this old, or it re-reads the provider first.
  ('marketing.paid.spend_sync.decision_max_age_minutes', '15', 'marketing'),
  -- Provider vs internal differences at or under this are rounding, not drift.
  ('marketing.paid.spend_sync.tolerance_cents', '100', 'marketing'),
  -- Pause all delivery automatically on a CEILING_BREACH (safety wins).
  ('marketing.paid.auto_pause_on_breach', 'true', 'marketing'),
  -- Landing visits in the first minutes after activation are provider ad-review crawls.
  ('marketing.paid.attribution.review_window_minutes', '10', 'marketing')
ON CONFLICT (key) DO NOTHING;

COMMIT;
