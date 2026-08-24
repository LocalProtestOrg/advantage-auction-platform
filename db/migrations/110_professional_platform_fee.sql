-- 110_professional_platform_fee.sql
--
-- Configurable Professional Seller platform/software fee. ADDITIVE ONLY, idempotent,
-- production-safe. Replaces the fixed 2% professional fee with a per-seller rate whose
-- DEFAULT is 4.00% (400 basis points).
--
-- Design:
--   • Rate lives on seller_profiles as INTEGER BASIS POINTS (cents-safe; matches the
--     existing `_bps` convention used by buyer_premium_bps). 400 bps = 4.00%.
--   • DEFAULT 400 applies to new AND existing rows (no grandfathering needed — there are
--     no real professional accounts yet). The fee is only APPLIED to professional seller
--     types in settlement; individual sellers keep 0% regardless of this column.
--   • Max 2500 bps (25%) mirrors the buyer_premium_bps validation ceiling.
--   • seller_payouts.platform_fee_bps snapshots the rate ACTUALLY APPLIED to a finalized
--     settlement, so historical reporting never depends on the seller's current setting.
--
-- This fee is the Advantage.Bid platform/software fee deducted from professional seller
-- proceeds. It is NOT the buyer premium, sales tax, or the Stripe processing fee — those
-- remain separate columns/concepts.

-- Per-seller configurable rate (default 4.00%).
ALTER TABLE seller_profiles
  ADD COLUMN IF NOT EXISTS platform_fee_bps INTEGER NOT NULL DEFAULT 400;

-- Guard the range (0%–25%). Added separately + guarded so re-runs never error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_seller_platform_fee_bps_range'
  ) THEN
    ALTER TABLE seller_profiles
      ADD CONSTRAINT chk_seller_platform_fee_bps_range
      CHECK (platform_fee_bps >= 0 AND platform_fee_bps <= 2500);
  END IF;
END$$;

-- Immutable snapshot of the rate actually applied to a finalized settlement.
ALTER TABLE seller_payouts
  ADD COLUMN IF NOT EXISTS platform_fee_bps INTEGER;
