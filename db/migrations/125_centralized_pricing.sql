-- 125_centralized_pricing.sql — Centralized pricing/fee architecture (owner-authoritative 2026-09-03).
--
-- Establishes the PUBLISH-TIME pricing snapshot on auctions and the separate processing-fee columns on
-- seller_payouts, seeds the authoritative centralized pricing config, and PROTECTS all existing records
-- by freezing every current auction as pricing_model='legacy' (processing was never charged historically).
--
-- KEY SAFETY: platform (4%) and processing (3%) are kept SEPARATE. New economics apply ONLY to auctions
-- published AFTER cutover (pricing_model='v2_separated'), resolved+frozen at publish. Legacy auctions keep
-- their exact prior economics (processing_fee_bps=0, actual-Stripe-cost reimbursement in the workbench).
-- Historical seller_payouts are untouched (processing_fee_cents defaults 0). Idempotent; additive.

-- ── Auction publish-time pricing snapshot (frozen before bidding) ────────────────
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS platform_fee_bps    INTEGER;      -- frozen platform/software fee (bps)
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS processing_fee_bps  INTEGER;      -- frozen card-processing fee (bps)
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS pricing_model       TEXT;         -- 'legacy' | 'v2_separated'
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS pricing_snapshot_at TIMESTAMPTZ;  -- when the snapshot was frozen

-- LEGACY PROTECTION: freeze every auction that is ALREADY LIVE or HISTORICAL (published / active / closed
-- / archived) as legacy. Processing was never deducted historically, so processing_fee_bps=0; the platform
-- snapshot mirrors the prior live resolution (professional → per-seller rate or 4% default; individual → 0).
-- This deterministically shields in-flight + closed auctions from the new 3% processing fee.
--
-- DRAFTS and other pre-publish states are intentionally LEFT NULL: when they are published AFTER cutover,
-- publishAuction() resolves + freezes the v2 economics at that point (owner rule: resolve at publication).
-- A NULL pricing_model settles as legacy (processing 0) by default until it is published, so it is safe.
UPDATE auctions a
   SET pricing_model = 'legacy',
       processing_fee_bps = 0,
       platform_fee_bps = COALESCE(a.platform_fee_bps,
         CASE WHEN sp.seller_type IN ('auction_house','estate_sale_company','professional_liquidator')
              THEN COALESCE(sp.platform_fee_bps, 400) ELSE 0 END),
       pricing_snapshot_at = COALESCE(a.pricing_snapshot_at, now())
  FROM seller_profiles sp
 WHERE a.seller_id = sp.id
   AND a.pricing_model IS NULL
   AND (a.state IN ('published', 'active', 'closed') OR a.is_archived IS TRUE);

-- ── seller_payouts: processing kept SEPARATE from the platform fee (never collapsed) ─
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS processing_fee_bps   INTEGER;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS processing_fee_cents INTEGER NOT NULL DEFAULT 0;
-- Existing payout rows keep processing_fee_cents = 0 (historical protection — no retroactive deduction).

-- ── Centralized authoritative pricing config (bps / cents). Separate platform & processing. ─
-- NO combined-total key exists: the 7% total is DERIVED, never independently editable.
INSERT INTO platform_config (key, value, category) VALUES
  ('pricing.auction.professional.platform_fee_bps', '400'::jsonb,  'pricing'),
  ('pricing.auction.processing_fee_bps',            '300'::jsonb,  'pricing'),
  ('pricing.auction.individual.platform_fee_bps',   '0'::jsonb,    'pricing'),
  ('pricing.auction.individual.buyer_premium_bps',  '1800'::jsonb, 'pricing'),
  ('pricing.storefront.seller_fee_bps',             '1100'::jsonb, 'pricing'),
  ('pricing.estate_sale.price_cents',               '3900'::jsonb, 'pricing'),
  ('pricing.appraiser.price_cents',                 '1999'::jsonb, 'pricing')
ON CONFLICT (key) DO NOTHING;
