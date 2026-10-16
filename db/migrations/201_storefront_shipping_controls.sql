-- 201: Professional Storefront shipping controls (owner requirements 2026-10-16; roadmap §7.1; src/lib/storefrontShipping.js).
-- ADDITIVE / IDEMPOTENT. Moves no money and changes no existing row: every new column is NULL / false, and the store
-- default starts OFF for every seller.
--   • Shipping defaults to NO: items stay pickup only unless the seller turns shipping on with complete details.
--   • A shippable item needs a supported method, destinations and either a set price (> $0) or a deliberate free-shipping
--     choice. A blank price is never free. Enforced by a trigger whenever an item is created or its shipping settings
--     change; existing listings are not rewritten (until their seller completes the details, checkout refuses to ship them).
--   • The store-wide default (seller_profiles.shipping_defaults) applies only to NEW items the seller chooses to apply it
--     to; changing it never changes an existing listing.

ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS shipping_method       TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS shipping_price_mode   TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS shipping_destinations TEXT;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS shipping_states       TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS handling_days         INTEGER;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS is_oversized          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS is_fragile            BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS shipping_defaults JSONB NOT NULL DEFAULT '{"enabled": false}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_shipping_method_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_shipping_method_check
      CHECK (shipping_method IS NULL OR shipping_method IN ('parcel','freight','white_glove','local_delivery'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_shipping_price_mode_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_shipping_price_mode_check
      CHECK (shipping_price_mode IS NULL OR shipping_price_mode IN ('flat','free'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_shipping_destinations_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_shipping_destinations_check
      CHECK (shipping_destinations IS NULL OR shipping_destinations IN ('us_contiguous','us_all','listed_states'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_handling_days_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_handling_days_check
      CHECK (handling_days IS NULL OR handling_days BETWEEN 0 AND 60);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_shipping_cost_nonneg') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_shipping_cost_nonneg
      CHECK (shipping_cost_cents IS NULL OR shipping_cost_cents >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_profiles_shipping_defaults_object') THEN
    ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_shipping_defaults_object
      CHECK (jsonb_typeof(shipping_defaults) = 'object' AND shipping_defaults ? 'enabled');
  END IF;
END $$;

-- Shipping can only be offered with complete terms; free is explicit and carries no price; a flat price is > $0.
-- A trigger (not a CHECK) so it applies only when an item is created or its shipping settings change: status changes by
-- checkout, sales or moderation never trip over an older listing whose seller has not completed its shipping details yet.
CREATE OR REPLACE FUNCTION marketplace_items_shipping_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.shippable IS NOT DISTINCT FROM OLD.shippable
     AND NEW.shipping_method IS NOT DISTINCT FROM OLD.shipping_method AND NEW.shipping_price_mode IS NOT DISTINCT FROM OLD.shipping_price_mode
     AND NEW.shipping_cost_cents IS NOT DISTINCT FROM OLD.shipping_cost_cents AND NEW.shipping_destinations IS NOT DISTINCT FROM OLD.shipping_destinations
     AND NEW.shipping_states IS NOT DISTINCT FROM OLD.shipping_states THEN
    RETURN NEW;
  END IF;
  -- COALESCE(..., false): an unknown (NULL) result counts as incomplete, never as complete.
  IF NEW.shippable IS TRUE AND NOT COALESCE((
       NEW.shipping_method IS NOT NULL AND NEW.shipping_destinations IS NOT NULL
       AND (NEW.shipping_destinations <> 'listed_states' OR cardinality(NEW.shipping_states) > 0)
       AND ((NEW.shipping_price_mode = 'free' AND NEW.shipping_cost_cents IS NULL)
         OR (NEW.shipping_price_mode = 'flat' AND NEW.shipping_cost_cents > 0))), false) THEN
    RAISE EXCEPTION 'shipping needs a method, destinations and a set price or explicit free shipping' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_marketplace_items_shipping_terms ON marketplace_items;
CREATE TRIGGER trg_marketplace_items_shipping_terms BEFORE INSERT OR UPDATE ON marketplace_items
  FOR EACH ROW EXECUTE FUNCTION marketplace_items_shipping_terms_guard();
