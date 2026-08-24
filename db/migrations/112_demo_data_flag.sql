-- 112_demo_data_flag.sql
--
-- Permanent sales-demo data classification. ADDITIVE ONLY, idempotent.
--
-- `is_demo = true` marks records that exist purely for sales demonstrations (a fictional estate-sale
-- company + a sample auction). Demo records are:
--   • excluded from the public marketplace feed (marketplaceVisibility native-auction predicate),
--   • never auto-closed by the state-transition scheduler (so they never create seller_payouts,
--     settlements, transfers, or tax transactions),
--   • excluded from operational auction-state diagnostics,
--   • programmatically identifiable for the demo reset script (which only ever touches is_demo rows).
--
-- No real seller, auction, payout, Stripe, or tax path is affected. Default false = every existing
-- record stays real.

ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE auctions        ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users           ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

-- Fast lookup for the demo reset script + demo-exclusion predicates.
CREATE INDEX IF NOT EXISTS idx_auctions_is_demo        ON auctions(is_demo)        WHERE is_demo = true;
CREATE INDEX IF NOT EXISTS idx_seller_profiles_is_demo ON seller_profiles(is_demo) WHERE is_demo = true;
