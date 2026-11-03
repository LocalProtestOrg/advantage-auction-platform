-- 214_storefront_shipping_quantity_and_tax_responsibility.sql (owner decisions 2026-11-02)
--
-- 1. Multi-unit shipping: the seller's own rule for a set shipping price when a buyer orders more than one
--    ('per_order' = one charge for the order, 'per_unit' = the price for each unit). NULL = not set: a multi-unit shipping
--    purchase is refused (never assumed). Free shipping stays free; single units are unchanged.
-- 2. Sales tax responsibility: Advantage.Bid calculates and collects tax on storefront purchases; who REMITS it depends on
--    the jurisdiction (marketplace-facilitator law) and is recorded per order:
--      'platform' = Advantage.Bid remits (the tax is never paid to the seller),
--      'seller'   = the seller remits (the collected tax is paid to the seller with the sale proceeds),
--      'none'     = no tax was collected.
--    The per-state rule lives in marketplace_tax_jurisdictions, maintained by an administrator from professional advice
--    (audited). A storefront order with tax in a state that has no rule is refused, so nothing is assumed nationwide.
--    Sales tax is never platform revenue and never in the 11% fee base (unchanged).
--
-- Rollback (only before any order records a tax responsibility):
--   ALTER TABLE marketplace_items DROP COLUMN shipping_quantity_rule;
--   ALTER TABLE marketplace_orders DROP COLUMN tax_jurisdiction, DROP COLUMN tax_remitter,
--     DROP COLUMN buyer_terms_version_id, DROP COLUMN buyer_terms_version_int;
--   DROP TABLE storefront_payout_recoveries; ALTER TABLE storefront_payouts DROP COLUMN recovery_cents;
--   ALTER TABLE storefront_payout_lines DROP COLUMN tax_to_seller_cents;
--   DROP TABLE marketplace_tax_jurisdictions;

ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS shipping_quantity_rule TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_shipping_quantity_rule_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_shipping_quantity_rule_check
      CHECK (shipping_quantity_rule IS NULL OR shipping_quantity_rule IN ('per_order', 'per_unit'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketplace_tax_jurisdictions (
  state           CHAR(2) PRIMARY KEY,                 -- US state / territory code of the taxed location
  remitter        TEXT NOT NULL CHECK (remitter IN ('platform', 'seller')),
  legal_basis     TEXT NOT NULL,                       -- the advice or statute relied on (who said so, when)
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  notes           TEXT,
  updated_by      UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS tax_jurisdiction TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS tax_remitter TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_tax_remitter_check') THEN
    ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_tax_remitter_check
      CHECK (tax_remitter IS NULL OR tax_remitter IN ('platform', 'seller', 'none'));
  END IF;
END $$;

-- 4. The platform Buyer Terms version in force for each storefront order (the seller's policy versions are already in
--    policy_snapshot). No foreign key: terms versions are immutable and never deleted.
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS buyer_terms_version_id UUID;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS buyer_terms_version_int INTEGER;

-- Seller-remitted tax included in a storefront payout (0 when Advantage.Bid remits or no tax was collected).
DO $$ BEGIN
  IF to_regclass('storefront_payout_lines') IS NOT NULL THEN
    ALTER TABLE storefront_payout_lines ADD COLUMN IF NOT EXISTS tax_to_seller_cents INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- 3. Refunds after the seller was already paid (owner decision 2026-11-02: refunds stay administrator-controlled; payouts are
--    adjusted). A refund on an order whose storefront payout was already paid records what must be recovered from the seller
--    (the lesser of the refund and what the seller received for that order). The next weekly payout deducts outstanding
--    recoveries (shown on the payout record); none is ever deducted twice.
CREATE TABLE IF NOT EXISTS storefront_payout_recoveries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_order_id  UUID NOT NULL UNIQUE REFERENCES marketplace_orders(id),
  seller_profile_id     UUID NOT NULL REFERENCES seller_profiles(id),
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  reason                TEXT NOT NULL,
  applied_payout_id     UUID,
  applied_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_storefront_payout_recoveries_open ON storefront_payout_recoveries (seller_profile_id) WHERE applied_payout_id IS NULL;
DO $$ BEGIN
  IF to_regclass('storefront_payouts') IS NOT NULL THEN
    ALTER TABLE storefront_payouts ADD COLUMN IF NOT EXISTS recovery_cents INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;
