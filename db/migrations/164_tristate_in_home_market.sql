-- 164_tristate_in_home_market.sql — ADDITIVE + idempotent.
--
-- The NYC-only market prepared by migration 163 (a 20-mile circle around Manhattan) is too narrow a
-- BUSINESS definition: Advantage.Bid's in-home service covers a Tri-State metropolitan footprint —
-- New York City and nearby New York suburbs, northern / central New Jersey and southwestern
-- Connecticut. It must not become all of New York, New Jersey and Connecticut either.
--
-- This migration:
--   1. versions market configuration (marketing_paid_market_versions), so every geography a market
--      has ever carried is kept and attributable;
--   2. RETIRES the 'nyc' market (row preserved, snapshot versioned) — it never launched and has no
--      campaigns, objects or spend;
--   3. adds the distinct market 'ny_tristate' — "New York Tri-State In-Home Service Area" —
--      PREPARED, not launch-authorized, geography UNVALIDATED until the provider resolves it;
--   4. adds an Owner geography approval that the DATABASE requires before any market can be ACTIVE.
--      Houston's geography was approved by the Owner with the first experiment and is recorded so.
--
-- Nothing here creates money. Markets still have no ceiling column: Houston and the Tri-State area
-- share the ONE global monthly ceiling. No campaign, experiment, arm, ledger row or provider object
-- is changed.

BEGIN;

-- ── 1. Market version history ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_paid_market_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_key    text        NOT NULL REFERENCES marketing_paid_markets(market_key),
  version       integer     NOT NULL,
  name          text        NOT NULL,
  status        text        NOT NULL,
  geo_spec      jsonb,
  geo_validation text,
  coverage      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  coverage_approval text,
  reason        text,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_mpmv_market_version UNIQUE (market_key, version)
);

ALTER TABLE marketing_paid_markets ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE marketing_paid_markets ADD COLUMN IF NOT EXISTS coverage jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE marketing_paid_markets ADD COLUMN IF NOT EXISTS coverage_approval text NOT NULL DEFAULT 'PENDING_OWNER_GEOGRAPHY_APPROVAL';
ALTER TABLE marketing_paid_markets ADD COLUMN IF NOT EXISTS coverage_approved_at timestamptz;
ALTER TABLE marketing_paid_markets ADD COLUMN IF NOT EXISTS superseded_by text REFERENCES marketing_paid_markets(market_key);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_mpm_coverage_approval') THEN
    ALTER TABLE marketing_paid_markets ADD CONSTRAINT chk_mpm_coverage_approval
      CHECK (coverage_approval IN ('PENDING_OWNER_GEOGRAPHY_APPROVAL','OWNER_APPROVED'));
  END IF;
END $$;

-- Houston's geography was Owner-authorized with the first experiment (2026-09-22).
UPDATE marketing_paid_markets
   SET coverage_approval = 'OWNER_APPROVED', coverage_approved_at = COALESCE(coverage_approved_at, launch_authorized_at, now())
 WHERE market_key = 'houston' AND coverage_approval <> 'OWNER_APPROVED';

-- An ACTIVE market needs an Owner-approved geography, enforced by the database (added after the
-- Houston backfill so the live market satisfies it).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_mpm_active_requires_coverage') THEN
    ALTER TABLE marketing_paid_markets ADD CONSTRAINT chk_mpm_active_requires_coverage
      CHECK (status <> 'ACTIVE' OR coverage_approval = 'OWNER_APPROVED');
  END IF;
END $$;

-- ── 2. The Tri-State market ──────────────────────────────────────────────────────────────────
INSERT INTO marketing_paid_markets (market_key, name, status, launch_authorized, notes)
VALUES ('ny_tristate', 'New York Tri-State In-Home Service Area', 'PREPARED', false,
  'In-home service footprint: NYC, nearby NY suburbs, northern/central NJ, southwestern CT. Shares the global monthly ceiling; creates no new authority.')
ON CONFLICT (market_key) DO NOTHING;

-- ── 3. Retire the NYC-only market, keeping its history ───────────────────────────────────────
INSERT INTO marketing_paid_market_versions (market_key, version, name, status, geo_spec, geo_validation, coverage, coverage_approval, reason)
SELECT market_key, version, name, status, geo_spec, geo_validation, jsonb_build_object('evidence', geo_evidence, 'plan', plan),
       coverage_approval, 'snapshot before retirement: superseded by ny_tristate (NYC-only definition too narrow)'
  FROM marketing_paid_markets WHERE market_key = 'nyc'
ON CONFLICT (market_key, version) DO NOTHING;

UPDATE marketing_paid_markets
   SET status = 'RETIRED', superseded_by = 'ny_tristate', launch_authorized = false, updated_at = now(),
       notes = COALESCE(notes, '') || ' RETIRED 2026-09-23: superseded by ny_tristate.'
 WHERE market_key = 'nyc' AND status <> 'RETIRED'
   AND NOT EXISTS (SELECT 1 FROM marketing_paid_campaigns WHERE market_key = 'nyc');

-- Houston's current definition is version 1 of its history.
INSERT INTO marketing_paid_market_versions (market_key, version, name, status, geo_spec, geo_validation, coverage, coverage_approval, reason)
SELECT market_key, version, name, status, geo_spec, geo_validation, '{}'::jsonb, coverage_approval, 'baseline version recorded by migration 164'
  FROM marketing_paid_markets WHERE market_key = 'houston'
ON CONFLICT (market_key, version) DO NOTHING;

COMMIT;
