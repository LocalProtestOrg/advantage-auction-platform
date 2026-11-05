-- 219_shipment_fulfillment_and_delivery.sql - Auction shipping Phase 3 scaffolding and the storefront shipped-order
-- delivery confirmation (owner-approved 2026-11-05; spec docs/projects/auction-shipping-spec.md; assessment
-- docs/projects/seller-fraud-protections-assessment.md sections 3 and 4). Additive only: one new empty table pair and three
-- new NULL columns. Changes no existing row's behavior. Read only while AUCTION_SHIPPING_ENABLED=true (auction shipments)
-- or STOREFRONT_SHIPPED_PAYOUT_DELAY_ENABLED=true (storefront delivery confirmation); both are off by default.
--
--   • auction_shipments: one shipment per buyer per auction (combined shipping), the total item value and the seller's
--     per-shipment limit fixed at creation, carrier and tracking (required to mark shipped, kept as recorded once set),
--     signature confirmation (required above $500 total item value unless an administrator override with a reason is
--     recorded), the per-shipment limit (exceeding it needs an administrator override with a reason), delivery
--     confirmation (buyer or administrator) and payout_release_at (delivery + 3 US Eastern business days, computed by
--     src/lib/auctionShippingPolicy.js payoutReleaseAt). Status moves forward only. Rows are never deleted.
--   • auction_shipment_lots: the lots in a shipment (a lot is in at most one shipment); never changed or deleted.
--   • marketplace_orders.delivered_at / delivery_confirmed_by / delivery_confirmation_source: who confirmed a shipped
--     storefront order arrived and when. Kept as recorded once set.
-- Same enforcement pattern as migration 197 (storefront order integrity): the database refuses what the service refuses.
-- Reverse: DROP TABLE auction_shipment_lots; DROP TABLE auction_shipments;
--          DROP FUNCTION auction_shipments_guard(); DROP FUNCTION auction_shipment_lots_guard();
--          DROP TRIGGER IF EXISTS trg_marketplace_orders_delivery_guard ON marketplace_orders; DROP FUNCTION marketplace_orders_delivery_guard();
--          ALTER TABLE marketplace_orders DROP COLUMN delivered_at, DROP COLUMN delivery_confirmed_by, DROP COLUMN delivery_confirmation_source;

CREATE TABLE IF NOT EXISTS auction_shipments (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id                   UUID NOT NULL REFERENCES auctions(id),
  seller_profile_id            UUID NOT NULL REFERENCES seller_profiles(id),
  buyer_user_id                UUID NOT NULL REFERENCES users(id),
  status                       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'shipped', 'delivered', 'cancelled')),
  total_item_value_cents       INTEGER NOT NULL CHECK (total_item_value_cents >= 0),
  per_shipment_limit_cents     INTEGER NOT NULL CHECK (per_shipment_limit_cents > 0),
  signature_confirmation       BOOLEAN NOT NULL DEFAULT false,      -- the seller bought signature confirmation for this shipment
  signature_override_by        UUID REFERENCES users(id),
  signature_override_reason    TEXT,
  signature_override_at        TIMESTAMPTZ,
  limit_override_by            UUID REFERENCES users(id),
  limit_override_reason        TEXT,
  limit_override_at            TIMESTAMPTZ,
  carrier                      TEXT CHECK (carrier IS NULL OR length(carrier) <= 60),
  tracking_number              TEXT CHECK (tracking_number IS NULL OR length(tracking_number) <= 80),
  shipped_at                   TIMESTAMPTZ,
  shipped_by                   UUID REFERENCES users(id),
  delivered_at                 TIMESTAMPTZ,
  delivery_confirmed_by        UUID REFERENCES users(id),
  delivery_confirmation_source TEXT CHECK (delivery_confirmation_source IS NULL OR delivery_confirmation_source IN ('buyer', 'admin')),
  delivery_note                TEXT CHECK (delivery_note IS NULL OR length(delivery_note) <= 500),
  payout_release_at            TIMESTAMPTZ,
  cancelled_at                 TIMESTAMPTZ,
  cancelled_by                 UUID REFERENCES users(id),
  cancel_reason                TEXT,
  created_by                   UUID REFERENCES users(id),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_auction_shipments_buyer UNIQUE (auction_id, buyer_user_id),
  -- An override always names the administrator and a reason.
  CONSTRAINT auction_shipments_signature_override_complete CHECK (signature_override_at IS NULL
    OR (signature_override_by IS NOT NULL AND length(btrim(COALESCE(signature_override_reason, ''))) >= 5)),
  CONSTRAINT auction_shipments_limit_override_complete CHECK (limit_override_at IS NULL
    OR (limit_override_by IS NOT NULL AND length(btrim(COALESCE(limit_override_reason, ''))) >= 5)),
  CONSTRAINT auction_shipments_cancel_complete CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND length(btrim(COALESCE(cancel_reason, ''))) >= 5))
);
CREATE INDEX IF NOT EXISTS idx_auction_shipments_auction ON auction_shipments (auction_id);
CREATE INDEX IF NOT EXISTS idx_auction_shipments_seller ON auction_shipments (seller_profile_id, status);

CREATE TABLE IF NOT EXISTS auction_shipment_lots (
  shipment_id      UUID NOT NULL REFERENCES auction_shipments(id),
  lot_id           UUID NOT NULL REFERENCES lots(id),
  item_value_cents INTEGER NOT NULL CHECK (item_value_cents >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shipment_id, lot_id),
  CONSTRAINT uq_auction_shipment_lots_lot UNIQUE (lot_id)
);

CREATE OR REPLACE FUNCTION auction_shipments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'auction shipment % is kept as a record and cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.tracking_number IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.payout_release_at IS NOT NULL THEN
      RAISE EXCEPTION 'an auction shipment starts as pending, without tracking or delivery' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Parties, value and limit are fixed at creation.
  IF NEW.auction_id IS DISTINCT FROM OLD.auction_id OR NEW.seller_profile_id IS DISTINCT FROM OLD.seller_profile_id
     OR NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.total_item_value_cents IS DISTINCT FROM OLD.total_item_value_cents
     OR NEW.per_shipment_limit_cents IS DISTINCT FROM OLD.per_shipment_limit_cents THEN
    RAISE EXCEPTION 'auction shipment % parties, value and limit are fixed', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- Status moves forward only.
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('shipped', 'cancelled'))
    OR (OLD.status = 'shipped' AND NEW.status = 'delivered')) THEN
    RAISE EXCEPTION 'auction shipment % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  -- Tracking, overrides, delivery and the payout release date are kept as recorded once set.
  IF (OLD.tracking_number IS NOT NULL AND NEW.tracking_number IS DISTINCT FROM OLD.tracking_number)
     OR (OLD.carrier IS NOT NULL AND NEW.carrier IS DISTINCT FROM OLD.carrier)
     OR (OLD.shipped_at IS NOT NULL AND NEW.shipped_at IS DISTINCT FROM OLD.shipped_at) THEN
    RAISE EXCEPTION 'auction shipment % tracking details are kept as recorded', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.signature_override_at IS NOT NULL AND (NEW.signature_override_at IS DISTINCT FROM OLD.signature_override_at
        OR NEW.signature_override_by IS DISTINCT FROM OLD.signature_override_by OR NEW.signature_override_reason IS DISTINCT FROM OLD.signature_override_reason))
     OR (OLD.limit_override_at IS NOT NULL AND (NEW.limit_override_at IS DISTINCT FROM OLD.limit_override_at
        OR NEW.limit_override_by IS DISTINCT FROM OLD.limit_override_by OR NEW.limit_override_reason IS DISTINCT FROM OLD.limit_override_reason)) THEN
    RAISE EXCEPTION 'auction shipment % overrides are kept as recorded', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND NEW.signature_confirmation IS DISTINCT FROM OLD.signature_confirmation THEN
    RAISE EXCEPTION 'auction shipment % signature confirmation is kept as recorded once shipped', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.delivered_at IS NOT NULL AND (NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
        OR NEW.delivery_confirmed_by IS DISTINCT FROM OLD.delivery_confirmed_by OR NEW.delivery_confirmation_source IS DISTINCT FROM OLD.delivery_confirmation_source))
     OR (OLD.payout_release_at IS NOT NULL AND NEW.payout_release_at IS DISTINCT FROM OLD.payout_release_at) THEN
    RAISE EXCEPTION 'auction shipment % delivery is kept as recorded', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- Marking shipped: carrier and tracking always; signature above $500 total item value unless an administrator override;
  -- the per-shipment limit unless an administrator override.
  IF NEW.status = 'shipped' AND OLD.status = 'pending' THEN
    IF length(btrim(COALESCE(NEW.carrier, ''))) = 0 OR length(btrim(COALESCE(NEW.tracking_number, ''))) = 0 OR NEW.shipped_at IS NULL THEN
      RAISE EXCEPTION 'auction shipment % needs a carrier and tracking number to be marked shipped', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.total_item_value_cents > 50000 AND NOT NEW.signature_confirmation AND NEW.signature_override_at IS NULL THEN
      RAISE EXCEPTION 'auction shipment % is above $500 and needs signature confirmation', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.total_item_value_cents > NEW.per_shipment_limit_cents AND NEW.limit_override_at IS NULL THEN
      RAISE EXCEPTION 'auction shipment % is above the seller''s per-shipment limit', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status IN ('pending', 'cancelled') AND (NEW.delivered_at IS NOT NULL OR NEW.payout_release_at IS NOT NULL) THEN
    RAISE EXCEPTION 'auction shipment % cannot be delivered before it ships', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Delivered: who, when, and a payout release date no earlier than the delivery.
  IF NEW.status = 'delivered' AND (NEW.delivered_at IS NULL OR NEW.delivery_confirmation_source IS NULL OR NEW.payout_release_at IS NULL
       OR NEW.payout_release_at < NEW.delivered_at) THEN
    RAISE EXCEPTION 'auction shipment % delivery needs a date, who confirmed it and a payout release date', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auction_shipments_guard ON auction_shipments;
CREATE TRIGGER trg_auction_shipments_guard BEFORE INSERT OR UPDATE OR DELETE ON auction_shipments
  FOR EACH ROW EXECUTE FUNCTION auction_shipments_guard();

CREATE OR REPLACE FUNCTION auction_shipment_lots_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auction shipment lots are kept as recorded' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS trg_auction_shipment_lots_guard ON auction_shipment_lots;
CREATE TRIGGER trg_auction_shipment_lots_guard BEFORE UPDATE OR DELETE ON auction_shipment_lots
  FOR EACH ROW EXECUTE FUNCTION auction_shipment_lots_guard();

-- Storefront: who confirmed a shipped order arrived, and when (STOREFRONT_SHIPPED_PAYOUT_DELAY_ENABLED).
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivery_confirmed_by UUID;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS delivery_confirmation_source TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_delivery_source_valid') THEN
    ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_delivery_source_valid
      CHECK (delivery_confirmation_source IS NULL OR delivery_confirmation_source IN ('buyer', 'admin'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION marketplace_orders_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.delivered_at IS NOT NULL AND (NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
       OR NEW.delivery_confirmed_by IS DISTINCT FROM OLD.delivery_confirmed_by
       OR NEW.delivery_confirmation_source IS DISTINCT FROM OLD.delivery_confirmation_source) THEN
    RAISE EXCEPTION 'marketplace order % delivery confirmation is kept as recorded', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.delivered_at IS NOT NULL AND OLD.delivered_at IS NULL AND (NEW.fulfillment_method <> 'shipping' OR NEW.delivery_confirmation_source IS NULL) THEN
    RAISE EXCEPTION 'marketplace order % delivery can be confirmed only for a shipped order, naming who confirmed it', OLD.order_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_marketplace_orders_delivery_guard ON marketplace_orders;
CREATE TRIGGER trg_marketplace_orders_delivery_guard BEFORE UPDATE ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_orders_delivery_guard();
