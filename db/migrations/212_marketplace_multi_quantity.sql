-- 212_marketplace_multi_quantity.sql
-- Multi-quantity fixed-price purchasing (owner priority 2026-11-02; roadmap §14, a required milestone before checkout).
--
-- Model (one path for every quantity, including one-of-one items):
--   • marketplace_items.quantity = units available to new buyers now (not held by a checkout, not sold).
--   • marketplace_items.quantity_sold = units sold on paid orders (a full refund takes its units back off this count).
--   • An order RESERVES its units when it is created: one atomic UPDATE ... SET quantity = quantity - n WHERE quantity >= n
--     under the item's row lock, so two buyers can never be sold the same unit. The reservation lives on the order
--     (quantity, hold_expires_at); stock_released_at records that a failed/canceled/expired order gave its units back, so
--     they are returned exactly once.
--   • A paid order keeps its units (quantity_sold += n). When nothing is available and nothing is held, the item is 'sold'.
--   • Every stock change is recorded in marketplace_stock_events (append-only).
-- The one-live-order-per-item index is replaced by the stock rule (several buyers may each hold units of one item).
--
-- Additive except the index swap. Existing orders: quantity 1, unit price = item price (backfilled), no hold expiry
-- (no checkout has run in production; MARKETPLACE_CHECKOUT_ENABLED is off).
--
-- Rollback (only while every order has quantity 1):
--   DROP TRIGGER IF EXISTS marketplace_orders_qty_guard ON marketplace_orders; DROP FUNCTION IF EXISTS marketplace_orders_qty_guard();
--   DROP TRIGGER IF EXISTS marketplace_stock_events_append_only ON marketplace_stock_events; DROP FUNCTION IF EXISTS marketplace_stock_events_append_only();
--   DROP TABLE IF EXISTS marketplace_stock_events;
--   ALTER TABLE marketplace_orders DROP COLUMN quantity, DROP COLUMN unit_price_cents, DROP COLUMN hold_expires_at, DROP COLUMN stock_released_at;
--   ALTER TABLE marketplace_items DROP COLUMN quantity_sold;
--   CREATE UNIQUE INDEX uq_marketplace_orders_live_item ON marketplace_orders (marketplace_item_id) WHERE payment_status IN ('pending','processing','paid');

ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS quantity_sold INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_quantity_sold_check') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_quantity_sold_check CHECK (quantity_sold >= 0);
  END IF;
END $$;
-- Items already sold through a paid order (single-unit sales before this migration): one unit sold, none left.
UPDATE marketplace_items mi SET quantity_sold = 1, quantity = 0
 WHERE quantity_sold = 0 AND EXISTS (SELECT 1 FROM marketplace_orders o WHERE o.marketplace_item_id = mi.id AND o.payment_status = 'paid' AND o.refund_status <> 'refunded');

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS quantity          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS unit_price_cents  INTEGER;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS hold_expires_at   TIMESTAMPTZ;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS stock_released_at TIMESTAMPTZ;
UPDATE marketplace_orders SET unit_price_cents = item_price_cents WHERE unit_price_cents IS NULL;
-- A checkout in progress before this migration held its item at the item level: move the hold onto the order.
UPDATE marketplace_orders o SET hold_expires_at = mi.pending_expires_at
  FROM marketplace_items mi
 WHERE mi.pending_order_id = o.id AND o.payment_status = 'pending' AND o.hold_expires_at IS NULL;
UPDATE marketplace_items mi SET quantity = 0
 WHERE mi.status = 'pending_purchase' AND mi.pending_order_id IS NOT NULL AND mi.quantity > 0;
-- Pending orders that never held anything (failed before this migration): nothing to give back.
UPDATE marketplace_orders SET stock_released_at = COALESCE(updated_at, now())
 WHERE payment_status IN ('failed', 'canceled') AND stock_released_at IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_quantity_check') THEN
    ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_quantity_check CHECK (quantity BETWEEN 1 AND 1000);
  END IF;
  -- The line total is exactly unit price x quantity (item_price_cents keeps meaning "the goods", which the fee, tax and
  -- seller proceeds are computed from).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_line_total_check') THEN
    ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_line_total_check
      CHECK (unit_price_cents IS NULL OR item_price_cents = unit_price_cents * quantity);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_holds ON marketplace_orders (hold_expires_at)
  WHERE payment_status = 'pending' AND stock_released_at IS NULL;

DROP INDEX IF EXISTS uq_marketplace_orders_live_item;

-- What was bought, how many and at what unit price never change after the order is created.
CREATE OR REPLACE FUNCTION marketplace_orders_qty_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity IS DISTINCT FROM OLD.quantity
     OR (OLD.unit_price_cents IS NOT NULL AND NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents) THEN
    RAISE EXCEPTION 'marketplace order quantity and unit price are fixed at purchase' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.stock_released_at IS NOT NULL AND NEW.stock_released_at IS DISTINCT FROM OLD.stock_released_at THEN
    RAISE EXCEPTION 'a released reservation cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS marketplace_orders_qty_guard ON marketplace_orders;
CREATE TRIGGER marketplace_orders_qty_guard BEFORE UPDATE ON marketplace_orders FOR EACH ROW EXECUTE FUNCTION marketplace_orders_qty_guard();

-- Every stock change, with why and who (append-only).
CREATE TABLE IF NOT EXISTS marketplace_stock_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Plain recorded ids (no foreign keys): the history outlives the removal of demo/test records it mentions.
  item_id       UUID NOT NULL,
  seller_id     UUID NOT NULL,
  order_id      UUID,
  delta         INTEGER NOT NULL,                       -- change to available units (negative = reserved or removed)
  sold_delta    INTEGER NOT NULL DEFAULT 0,             -- change to units sold
  available_after INTEGER NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('reserved', 'released', 'sold', 'refunded', 'seller_adjusted')),
  actor_user_id UUID,                                   -- who made a seller adjustment (kept even if the account is later removed)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_stock_events_item ON marketplace_stock_events (item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_stock_events_order ON marketplace_stock_events (order_id) WHERE order_id IS NOT NULL;
CREATE OR REPLACE FUNCTION marketplace_stock_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'marketplace_stock_events is append-only' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS marketplace_stock_events_append_only ON marketplace_stock_events;
CREATE TRIGGER marketplace_stock_events_append_only BEFORE UPDATE OR DELETE ON marketplace_stock_events
  FOR EACH ROW EXECUTE FUNCTION marketplace_stock_events_append_only();
