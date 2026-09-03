-- 127_marketing_lifecycle_shortfall.sql — Marketing package lifecycle eligibility snapshot + settlement
-- shortfall/loss policy. ADDITIVE ONLY. No seller chargeable payment method, no receivable, no clawback,
-- no carry-forward. The shortfall table records an internal accounting FACT (business loss) — it is never
-- seller-collectible and never seller-facing.

-- ── marketing_jobs: eligibility snapshot at purchase (auditability, NOT billing) ────
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS elig_total_lots       INTEGER;
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS elig_clothing_lots    INTEGER;
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS elig_clothing_pct_bps INTEGER;
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS elig_rule_version     TEXT;
ALTER TABLE marketing_jobs ADD COLUMN IF NOT EXISTS elig_evaluated_at     TIMESTAMPTZ;

-- ── seller_payouts: marketing package charge deducted (Concept A) + shortfall figures ─
-- Existing rows keep 0 (historical protection — no retroactive marketing deduction or shortfall).
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS marketing_charge_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS shortfall_cents        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS shortfall_recorded_at  TIMESTAMPTZ;

-- ── settlement_shortfalls: auditable business-loss record (EXACTLY ONE per auction) ──
-- Records the economic fact that applicable Advantage.Bid charges could not be fully recovered from the
-- sale proceeds. NOT a money-movement ledger; NOT invoiced; NOT carried forward. Traceable so the
-- Owner/accountant can classify it for tax/accounting (software makes NO legal/tax determination).
CREATE TABLE IF NOT EXISTS settlement_shortfalls (
  auction_id                  UUID PRIMARY KEY REFERENCES auctions(id) ON DELETE CASCADE,  -- exactly once
  seller_user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  marketing_job_id            UUID REFERENCES marketing_jobs(id) ON DELETE SET NULL,
  gross_proceeds_cents        INTEGER NOT NULL,
  total_deductions_cents      INTEGER NOT NULL,
  amount_recovered_cents      INTEGER NOT NULL,
  unrecovered_shortfall_cents INTEGER NOT NULL CHECK (unrecovered_shortfall_cents >= 0),
  marketing_charge_cents      INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents          INTEGER NOT NULL DEFAULT 0,
  processing_fee_cents        INTEGER NOT NULL DEFAULT 0,
  reason                      TEXT NOT NULL DEFAULT 'proceeds_insufficient',
  loss_type                   TEXT NOT NULL DEFAULT 'settlement_shortfall',
  breakdown                   JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settlement_shortfalls_seller ON settlement_shortfalls(seller_user_id);
