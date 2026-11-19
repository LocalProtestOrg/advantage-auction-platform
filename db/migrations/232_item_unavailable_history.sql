-- 232_item_unavailable_history.sql
-- Historical item pages after a refund (owner 2026-11-19). A full refund takes a fully sold item off sale (status
-- 'removed', never relisted automatically). Until now that also made its public page "not found". The page now stays
-- at its original address marked "No longer available": photographs, description and seller kept, no price, no checkout.
--
-- marketplace_items.unavailable_since marks exactly that case and nothing else. It is set only by the refund, and a
-- trigger clears it whenever the item is no longer 'removed' or is taken down by moderation, so:
--   * a seller's own removal stays hidden (it never sets the mark);
--   * relisting, or moving the item to draft (the seller's way to hide the page), clears it for good;
--   * a moderation takedown hides the page and clears it.
--
-- Additive: one nullable column, one trigger, and a one-time backfill of items a refund already took off sale and that
-- have not been touched since (the refund stamps the order and the item with the same transaction time).
--
-- Rollback: DROP TRIGGER IF EXISTS trg_marketplace_items_unavailable_since ON marketplace_items;
--           DROP FUNCTION IF EXISTS marketplace_items_unavailable_since(); ALTER TABLE marketplace_items DROP COLUMN unavailable_since;

BEGIN;

ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS unavailable_since timestamptz;

CREATE OR REPLACE FUNCTION marketplace_items_unavailable_since() RETURNS trigger AS $$
BEGIN
  IF NEW.unavailable_since IS NOT NULL AND (NEW.status <> 'removed' OR NEW.moderation_status <> 'none') THEN
    NEW.unavailable_since := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_marketplace_items_unavailable_since ON marketplace_items;
CREATE TRIGGER trg_marketplace_items_unavailable_since BEFORE INSERT OR UPDATE ON marketplace_items
  FOR EACH ROW EXECUTE FUNCTION marketplace_items_unavailable_since();

UPDATE marketplace_items mi
   SET unavailable_since = o.refunded_at
  FROM marketplace_orders o
 WHERE o.marketplace_item_id = mi.id AND o.refund_status = 'refunded' AND o.refunded_at IS NOT NULL
   AND mi.status = 'removed' AND mi.moderation_status = 'none' AND mi.unavailable_since IS NULL
   AND mi.updated_at = o.refunded_at
   AND NOT EXISTS (SELECT 1 FROM marketplace_orders p WHERE p.marketplace_item_id = mi.id AND p.payment_status = 'paid');

COMMIT;
