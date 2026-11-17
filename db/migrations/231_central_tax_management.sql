-- 231_central_tax_management.sql - ADDITIVE. Centralized sales tax management for all three channels (auctions,
-- marketplace sales, embedded storefront sales). Owner authorization 2026-11-16.
--
--  1. marketplace_tax_jurisdictions (migrations 214, 227) now governs auctions too and gains source, verification and
--     local-jurisdiction fields. Its history is kept in tax_jurisdiction_history (append-only).
--  2. tax_registrations / tax_filings: registrations, filing frequency, deadlines, confirmations, payments.
--  3. tax_ledger_entries: the permanent append-only tax ledger (UPDATE and DELETE are refused by a trigger; corrections
--     are new adjustment rows).
--  4. tax_category_codes: merchandise category to tax product code.
--  5. tax_nexus_thresholds: per-state economic nexus rules entered from official sources.
--  6. tax_payment_exceptions: administrator exceptions for an auction whose payments are held by the tax safeguard.
--  7. tax_alerts / tax_reconciliation_runs: administrator alerts and reconciliation history.
--  8. payments.tax_remitter / tax_jurisdiction / tax_basis / tax_detail; marketplace_orders.tax_basis / tax_detail: who is
--     responsible, where, and why the tax amount is what it is, recorded per transaction.
--  9. platform_config: tax.auction_enforcement ('report' until the owner turns enforcement on) and tax.reserve_guard.
--
-- No existing row is changed. No rule, registration or threshold is created: those are administrator entries made from
-- professional advice. Rollback (only before any ledger entry is posted): drop the tables below, the trigger function
-- tax_ledger_append_only(), the added columns, and the two platform_config keys.
BEGIN;

ALTER TABLE marketplace_tax_jurisdictions ADD COLUMN IF NOT EXISTS source_reference   TEXT;
ALTER TABLE marketplace_tax_jurisdictions ADD COLUMN IF NOT EXISTS local_jurisdiction TEXT;
ALTER TABLE marketplace_tax_jurisdictions ADD COLUMN IF NOT EXISTS last_verified_at   DATE;
ALTER TABLE marketplace_tax_jurisdictions ADD COLUMN IF NOT EXISTS last_verified_by   UUID;

CREATE TABLE IF NOT EXISTS tax_jurisdiction_history (
  id            BIGSERIAL PRIMARY KEY,
  state         CHAR(2) NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('set', 'removed', 'verified')),
  before_value  JSONB,
  after_value   JSONB,
  actor_user_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_jurisdiction_history_state ON tax_jurisdiction_history(state, created_at);

CREATE TABLE IF NOT EXISTS tax_registrations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state                 CHAR(2) NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'active', 'closed')),
  effective_from        DATE,
  effective_to          DATE,
  filing_frequency      TEXT CHECK (filing_frequency IS NULL OR filing_frequency IN ('monthly', 'quarterly', 'annual', 'other')),
  zero_filing_required  BOOLEAN NOT NULL DEFAULT true,
  registration_last4    TEXT CHECK (registration_last4 IS NULL OR length(registration_last4) <= 4),   -- never the full number
  processor_registered  BOOLEAN NOT NULL DEFAULT false,   -- an administrator confirmed the matching registration in the tax calculation provider
  notes                 TEXT,
  created_by            UUID,
  updated_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_registrations_open_state ON tax_registrations(state) WHERE status <> 'closed';

CREATE TABLE IF NOT EXISTS tax_filings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state               CHAR(2) NOT NULL,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  due_date            DATE,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filed', 'paid')),
  tax_due_cents       BIGINT,                 -- the amount on the return as filed
  filed_at            DATE,
  filed_by_method     TEXT CHECK (filed_by_method IS NULL OR filed_by_method IN ('accountant', 'self', 'processor', 'service')),
  confirmation_number TEXT,
  notes               TEXT,
  created_by          UUID,
  updated_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (state, period_start, period_end)
);

-- The ledger. Amounts are signed cents: a sale is positive, a refund negative. One row per financial event; the
-- idempotency_key makes every posting safe to repeat. Liability for a state and period is
-- sum(tax_collected_cents where remitter = 'platform') - sum(tax_remitted_cents).
CREATE TABLE IF NOT EXISTS tax_ledger_entries (
  id                    BIGSERIAL PRIMARY KEY,
  idempotency_key       TEXT NOT NULL UNIQUE,
  entry_type            TEXT NOT NULL CHECK (entry_type IN ('sale', 'refund', 'dispute', 'remittance', 'reserve_transfer', 'adjustment')),
  channel               TEXT NOT NULL CHECK (channel IN ('auction', 'marketplace', 'seller_website', 'platform')),
  source_type           TEXT NOT NULL CHECK (source_type IN ('auction_payment', 'marketplace_order', 'filing', 'manual')),
  source_id             TEXT,
  occurred_at           TIMESTAMPTZ NOT NULL,
  tax_period            DATE NOT NULL,          -- first day of the month of occurred_at, America/New_York
  state                 CHAR(2),
  jurisdiction_detail   JSONB,
  remitter              TEXT CHECK (remitter IS NULL OR remitter IN ('platform', 'seller', 'seller_direct', 'none', 'unconfigured', 'exception')),
  tax_basis             TEXT,
  seller_profile_id     UUID,
  buyer_user_id         UUID,
  auction_id            UUID,
  gross_cents           BIGINT NOT NULL DEFAULT 0,
  merchandise_cents     BIGINT NOT NULL DEFAULT 0,
  buyer_premium_cents   BIGINT NOT NULL DEFAULT 0,
  shipping_cents        BIGINT NOT NULL DEFAULT 0,
  taxable_cents         BIGINT NOT NULL DEFAULT 0,
  exempt_cents          BIGINT NOT NULL DEFAULT 0,
  tax_calculated_cents  BIGINT NOT NULL DEFAULT 0,
  tax_collected_cents   BIGINT NOT NULL DEFAULT 0,
  seller_proceeds_cents BIGINT NOT NULL DEFAULT 0,
  platform_fee_cents    BIGINT NOT NULL DEFAULT 0,
  tax_remitted_cents    BIGINT NOT NULL DEFAULT 0,
  tax_reserved_cents    BIGINT NOT NULL DEFAULT 0,
  payment_intent_id     TEXT,
  tax_calculation_id    TEXT,
  tax_transaction_id    TEXT,
  tax_reversal_id       TEXT,
  filing_id             UUID,
  reverses_entry_id     BIGINT,
  note                  TEXT,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_ledger_state_period ON tax_ledger_entries(state, tax_period);
CREATE INDEX IF NOT EXISTS idx_tax_ledger_source ON tax_ledger_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_tax_ledger_seller ON tax_ledger_entries(seller_profile_id, occurred_at);

CREATE OR REPLACE FUNCTION tax_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tax_ledger_entries is append-only: post an adjustment entry instead';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tax_ledger_append_only ON tax_ledger_entries;
CREATE TRIGGER trg_tax_ledger_append_only BEFORE UPDATE OR DELETE ON tax_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION tax_ledger_append_only();

CREATE TABLE IF NOT EXISTS tax_category_codes (
  category_key      TEXT PRIMARY KEY,
  tax_code          TEXT NOT NULL CHECK (tax_code ~ '^txcd_[0-9]{8}$'),
  source_reference  TEXT,
  notes             TEXT,
  updated_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tax_nexus_thresholds (
  state                     CHAR(2) PRIMARY KEY,
  sales_threshold_cents     BIGINT,
  transaction_threshold     INTEGER,
  combine_rule              TEXT NOT NULL DEFAULT 'or' CHECK (combine_rule IN ('or', 'and')),
  measurement_period        TEXT NOT NULL DEFAULT 'calendar_year'
                            CHECK (measurement_period IN ('calendar_year', 'previous_calendar_year', 'current_or_previous_calendar_year', 'rolling_12_months')),
  counts_marketplace_sales  BOOLEAN,            -- NULL = not yet determined (flagged for review)
  physical_presence         BOOLEAN NOT NULL DEFAULT false,
  legal_reference           TEXT NOT NULL,
  source_url                TEXT,
  effective_from            DATE,
  verified_at               DATE,
  verified_by               UUID,
  notes                     TEXT,
  updated_by                UUID,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tax_payment_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id      UUID NOT NULL,
  state           CHAR(2) NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('proceed_tax_not_collected')),
  reason          TEXT NOT NULL,
  approved_by     UUID NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_payment_exceptions_active ON tax_payment_exceptions(auction_id, state) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS tax_alerts (
  id            BIGSERIAL PRIMARY KEY,
  alert_key     TEXT NOT NULL,                  -- stable identity of the condition (one open alert per key)
  alert_type    TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  message       TEXT NOT NULL,
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID,
  resolution    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_alerts_open_key ON tax_alerts(alert_key) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS tax_reconciliation_runs (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'clean', 'mismatches', 'failed')),
  summary      JSONB,
  triggered_by UUID
);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS tax_remitter     TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS tax_jurisdiction TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS tax_basis        TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS tax_basis TEXT;
-- What the calculation said: the taxable amount and each jurisdiction's share (state, county, city, district).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS tax_detail JSONB;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS tax_detail JSONB;

INSERT INTO platform_config (key, value, category, description) VALUES
  ('tax.auction_enforcement', '"report"'::jsonb, 'tax',
   'Auction sales tax safeguard: "report" records and alerts on auctions in a state without a tax rule; "enforce" refuses to publish them and holds their payments.'),
  ('tax.reserve_guard', 'true'::jsonb, 'tax',
   'Seller payouts are refused when they would spend money held for sales tax Advantage.Bid must remit.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
