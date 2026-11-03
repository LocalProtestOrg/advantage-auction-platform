-- 215_storefront_channel_commission.sql (owner decision 2026-11-03)
--
-- Professional Storefront commission by sales channel, replacing the flat 11%:
--   seller_website  5% of the item price (the shopper began in the seller's embedded storefront on the seller's website)
--   marketplace     9% of the item price (every other way an order reaches Advantage.Bid checkout)
-- Card processing is included in both; no subscription or listing fee. The rate itself lives in code
-- (src/services/storefrontChannelService.js FEE_BPS); each order keeps the rate it was created with in platform_fee_bps,
-- which the database already protects (migration 197). This migration adds the channel record beside it.
--
-- 1. marketplace_orders.sales_channel / sales_channel_basis / channel_pass_id / channel_embedding_site / fee_schedule:
--    set when the order is created and never changed afterwards (trigger below). NULL on orders created before this
--    migration (production had none).
-- 2. storefront_channel_passes: a website pass is bound to the first buyer who orders with it, so a copied pass never
--    gives another buyer's order the website rate. One row per pass USED (page views store nothing).
-- 3. marketplace_orders.processing_fee_cents: the card processing fee the payment processor actually charged for the
--    order (read from the charge after payment), for Advantage.Bid's own accounting. Never charged to the seller.
-- 4. The customer service article on the storefront fee states the new rates (only while it still states the 11%).
--
-- Rollback (only before any order records a channel):
--   DROP TRIGGER marketplace_orders_channel_guard ON marketplace_orders; DROP FUNCTION marketplace_orders_channel_guard();
--   ALTER TABLE marketplace_orders DROP COLUMN sales_channel, DROP COLUMN sales_channel_basis, DROP COLUMN channel_pass_id,
--     DROP COLUMN channel_embedding_site, DROP COLUMN fee_schedule, DROP COLUMN processing_fee_cents;
--   DROP TABLE storefront_channel_passes;
--   (the article keeps its new text; restore the previous version from cs_kb_articles history if required)

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS sales_channel TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS sales_channel_basis TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS channel_pass_id TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS channel_embedding_site TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS fee_schedule TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS processing_fee_cents INTEGER;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_sales_channel_check') THEN
    ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_sales_channel_check
      CHECK (sales_channel IS NULL OR sales_channel IN ('seller_website', 'marketplace'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_processing_fee_check') THEN
    ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_processing_fee_check
      CHECK (processing_fee_cents IS NULL OR processing_fee_cents >= 0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_sales_channel ON marketplace_orders (sales_channel) WHERE sales_channel IS NOT NULL;

-- The channel is fixed with the order (like its rate, migration 197). The processing fee may be recorded once.
CREATE OR REPLACE FUNCTION marketplace_orders_channel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sales_channel IS DISTINCT FROM OLD.sales_channel OR NEW.sales_channel_basis IS DISTINCT FROM OLD.sales_channel_basis
     OR NEW.channel_pass_id IS DISTINCT FROM OLD.channel_pass_id OR NEW.channel_embedding_site IS DISTINCT FROM OLD.channel_embedding_site
     OR NEW.fee_schedule IS DISTINCT FROM OLD.fee_schedule THEN
    RAISE EXCEPTION 'marketplace order %: the sales channel and commission are fixed when the order is created', OLD.order_number
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.processing_fee_cents IS NOT NULL AND NEW.processing_fee_cents IS DISTINCT FROM OLD.processing_fee_cents THEN
    RAISE EXCEPTION 'marketplace order %: the recorded processing fee cannot change', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS marketplace_orders_channel_guard ON marketplace_orders;
CREATE TRIGGER marketplace_orders_channel_guard BEFORE UPDATE ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_orders_channel_guard();

CREATE TABLE IF NOT EXISTS storefront_channel_passes (
  pass_id            TEXT PRIMARY KEY,                     -- the pass's random id (not the signed pass itself)
  seller_profile_id  UUID NOT NULL REFERENCES seller_profiles(id),
  buyer_user_id      UUID NOT NULL REFERENCES users(id),   -- the first buyer who ordered with it
  embedding_site     TEXT,                                 -- the website host the browser reported, for review
  issued_at          TIMESTAMPTZ NOT NULL,
  first_used_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_storefront_channel_passes_seller ON storefront_channel_passes (seller_profile_id, first_used_at DESC);

DO $$ BEGIN
  IF to_regclass('cs_kb_articles') IS NOT NULL THEN
    UPDATE cs_kb_articles
       SET body = replace(body,
             'Professional Storefront fixed-price sales have a flat 11% seller fee, calculated on the item selling price only. The 11% includes card processing. Shipping and sales tax are not included in the fee calculation.',
             'Professional Storefront fixed-price sales have a seller commission calculated on the item selling price only: 5% when the sale comes through the seller''s own website using the Advantage.Bid embedded storefront, and 9% when it comes through the Advantage.Bid marketplace. Both include card processing. Shipping and sales tax are not included in the calculation. There is no monthly subscription and no listing fee.'),
           version = version + 1,
           source = 'Owner decision (2026-11-03); seller agreement §6.9',
           updated_at = now()
     WHERE slug = 'professional-storefront-fee'
       AND body LIKE '%flat 11% seller fee, calculated on the item selling price only%';
  END IF;
END $$;
