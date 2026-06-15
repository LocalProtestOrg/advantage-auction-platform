-- 069_buyer_premium_billing_terms.sql
-- BUYER PREMIUM PHASE 1 (config + settlement PREVIEW only). Additive + idempotent.
-- Does NOT change what buyers are charged or what sellers are paid: the live flat
-- 10% payout (seller_payouts.gross/platform_fee/seller_payout_cents) is untouched.
-- These columns store admin config + a clearly-labeled PREVIEW breakdown.

-- Per-seller default split + hammer commission (buyer_premium_pct already exists)
ALTER TABLE seller_terms ADD COLUMN IF NOT EXISTS aac_bp_share_pct          NUMERIC(5,2);
ALTER TABLE seller_terms ADD COLUMN IF NOT EXISTS aac_hammer_commission_pct NUMERIC(5,2);

-- Per-auction admin override (nullable ⇒ inherit seller default; buyer_premium_bps already exists)
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS aac_bp_share_bps          INTEGER;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS aac_hammer_commission_bps INTEGER;

-- Settlement PREVIEW breakdown + reproducible snapshot (NOT the live payout)
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS buyer_premium_cents         INTEGER;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS aac_bp_share_cents          INTEGER;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS seller_bp_share_cents       INTEGER;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS aac_hammer_commission_cents INTEGER;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS terms_snapshot              JSONB;
