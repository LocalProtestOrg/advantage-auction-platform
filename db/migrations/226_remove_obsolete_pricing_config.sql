-- 226_remove_obsolete_pricing_config.sql - remove pricing settings that no code reads and that state retired rates
-- (production consistency audit 2026-11-06, owner-authorized correction).
--
--   pricing.storefront.seller_fee_bps = 1100   the old flat 11% storefront fee; the commission is 5% / 9% by sales channel,
--                                              fixed in src/services/storefrontChannelService.js and recorded on each order
--   business.buyer_premium_pct        = 0      retired 0% pilot values from migration 078; buyer premium and seller fees
--   business.seller_commission_pct    = 0      come from billingTermsService / settlementPolicy / pricingConfigService
--   business.platform_fee_pct         = 0
--
-- Nothing reads these keys (verified by search of src/, public/ and tests/), so removing them changes no fee or behavior.
-- They are removed so no admin screen or report can show a stale rate.
-- Reverse (re-creates the rows as seeded by 078 and 125; the pre-226 backup holds any later edits):
--   INSERT INTO platform_config (key, value, category, description) VALUES
--     ('pricing.storefront.seller_fee_bps', '1100', 'pricing', NULL),
--     ('business.buyer_premium_pct', '0', 'business', 'Buyer premium % (config only; not yet enforced by settlement)'),
--     ('business.seller_commission_pct', '0', 'business', 'Seller commission % (config only; not yet enforced)'),
--     ('business.platform_fee_pct', '0', 'business', 'Platform fee % (config only; not yet enforced)')
--   ON CONFLICT (key) DO NOTHING;

DELETE FROM platform_config
 WHERE key IN ('pricing.storefront.seller_fee_bps', 'business.buyer_premium_pct', 'business.seller_commission_pct', 'business.platform_fee_pct');
