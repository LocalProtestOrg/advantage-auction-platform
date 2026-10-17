-- 204: Milestone N — seller inventory numbers and reliable paid-sale seller notifications (roadmap §8.1–8.2).
-- ADDITIVE / IDEMPOTENT. Moves no money; changes no existing row.
--   • marketplace_items.inventory_number: the seller's own optional inventory number / SKU. Unique within ONE seller's live
--     items (draft, active, in checkout); different sellers may use the same numbers; sold/removed items keep theirs.
--   • storefront_notifications: an outbox. One row per (order, event, recipient), written in the same transaction that
--     marks an order paid, delivered by a worker with retries. A row can only reference its own seller's order.

ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS inventory_number TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_items_inventory_number_format') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT marketplace_items_inventory_number_format
      CHECK (inventory_number IS NULL OR (length(inventory_number) BETWEEN 1 AND 64 AND inventory_number = btrim(inventory_number)));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_items_seller_inventory_number
  ON marketplace_items (seller_id, lower(inventory_number))
  WHERE inventory_number IS NOT NULL AND status IN ('draft','active','pending_purchase');

CREATE TABLE IF NOT EXISTS storefront_notifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           UUID NOT NULL,
  order_id            UUID NOT NULL,
  event               TEXT NOT NULL CHECK (event IN ('sale_paid')),
  recipient_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,   -- the email address stays the delivery record
  recipient_email     TEXT NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 320),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','skipped')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at           TIMESTAMPTZ,
  last_error          TEXT,
  provider_message_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  is_demo             BOOLEAN NOT NULL DEFAULT false,
  -- CASCADE only matters for demo orders (real orders can never be deleted — migration 197).
  CONSTRAINT fk_storefront_notifications_order_seller FOREIGN KEY (order_id, seller_id) REFERENCES marketplace_orders (id, seller_id) ON DELETE CASCADE,
  CONSTRAINT uq_storefront_notification_once UNIQUE (order_id, event, recipient_email)
);
CREATE INDEX IF NOT EXISTS idx_storefront_notifications_ready ON storefront_notifications (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_storefront_notifications_processing ON storefront_notifications (locked_at) WHERE status = 'processing';

-- A notice keeps its seller, order, event and recipient; it is never deleted (except demo rows used for testing).
CREATE OR REPLACE FUNCTION storefront_notifications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- demo status always comes from the order itself, never from the writer
    NEW.is_demo := COALESCE((SELECT o.is_demo FROM marketplace_orders o WHERE o.id = NEW.order_id), false);
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_demo THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'storefront notifications are kept as delivery records' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.seller_id IS DISTINCT FROM OLD.seller_id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.event IS DISTINCT FROM OLD.event
     OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email OR NEW.is_demo IS DISTINCT FROM OLD.is_demo
     OR (NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id AND NEW.recipient_user_id IS NOT NULL)
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a storefront notification keeps its seller, order, event and recipient' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'sent' AND NEW.status <> 'sent' THEN
    RAISE EXCEPTION 'a sent notification stays sent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_storefront_notifications_guard ON storefront_notifications;
CREATE TRIGGER trg_storefront_notifications_guard BEFORE INSERT OR UPDATE OR DELETE ON storefront_notifications
  FOR EACH ROW EXECUTE FUNCTION storefront_notifications_guard();
