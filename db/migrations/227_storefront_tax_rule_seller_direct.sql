-- 227_storefront_tax_rule_seller_direct.sql — ADDITIVE. Storefront sales tax rules (migration 214) gain a third answer,
-- so the checkout safeguard can follow whichever configuration the CPA approves (owner, 2026-11-09):
--   'platform'      Advantage.Bid collects at checkout and remits (marketplace provider);
--   'seller'        Advantage.Bid collects at checkout for the seller and pays it to the seller, who remits;
--   'seller_direct' NO tax is collected at checkout; the seller accounts for its own tax outside Advantage.Bid.
-- Nothing else changes: no row is added, changed or removed. A state with no rule still refuses every storefront order.
BEGIN;
ALTER TABLE marketplace_tax_jurisdictions DROP CONSTRAINT IF EXISTS marketplace_tax_jurisdictions_remitter_check;
ALTER TABLE marketplace_tax_jurisdictions ADD CONSTRAINT marketplace_tax_jurisdictions_remitter_check
  CHECK (remitter IN ('platform', 'seller', 'seller_direct'));
COMMIT;
