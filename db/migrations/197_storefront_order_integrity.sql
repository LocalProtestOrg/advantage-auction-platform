-- 197: Professional Storefront order integrity (security standard, owner 2026-10-16).
-- ADDITIVE / IDEMPOTENT. Moves no money and changes no existing value. The database itself now guarantees:
--   1. an order's seller is the seller of the item it bought (composite foreign key), and an item's owner can never change
--      once anyone has ordered it;
--   2. the ownership and money snapshot of an order is fixed when the order is created (who sold, who bought, what was
--      bought, at what price, shipping, fee and proceeds); tax and total can only be set while the order is still unpaid;
--   3. payment, refund and fulfillment states only move forward; tracking details, once recorded, are kept;
--   4. a refunded amount never decreases or exceeds the charge; payout eligibility needs a paid, unrefunded, fulfilled order
--      that is not on hold (a chargeback places it on hold);
--   5. order history (marketplace_order_events) and buyer issues (marketplace_order_issues) always carry the order's real
--      seller and buyer: a row naming any other seller or buyer is rejected, never corrected;
--   6. real (non-demo) orders and their history cannot be deleted.
-- Production has no storefront orders yet (2026-10-16), so every constraint validates against an empty set.

-- ── Snapshot + payout-hold columns ────────────────────────────────────────────────────────────────────
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS item_snapshot     JSONB;   -- item identity + listing terms at purchase
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS seller_snapshot   JSONB;   -- seller identity at purchase
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS pickup_snapshot   JSONB;   -- full pickup address at purchase (private)
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS payout_hold        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS payout_hold_reason TEXT;

-- ── Ownership-consistent keys ─────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_marketplace_items_id_seller') THEN
    ALTER TABLE marketplace_items ADD CONSTRAINT uq_marketplace_items_id_seller UNIQUE (id, seller_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_marketplace_orders_item_seller') THEN
    -- NO ACTION on update: an item's seller_id cannot change while any order references it.
    ALTER TABLE marketplace_orders ADD CONSTRAINT fk_marketplace_orders_item_seller
      FOREIGN KEY (marketplace_item_id, seller_id) REFERENCES marketplace_items (id, seller_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_marketplace_orders_parties') THEN
    ALTER TABLE marketplace_orders ADD CONSTRAINT uq_marketplace_orders_parties UNIQUE (id, seller_id, buyer_user_id);
  END IF;
END $$;

-- ── Order guard: fixed snapshot, forward-only states ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION marketplace_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seller_user UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_demo THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'marketplace order % cannot be deleted', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT user_id INTO seller_user FROM seller_profiles WHERE id = NEW.seller_id;
    IF seller_user IS NOT NULL AND seller_user = NEW.buyer_user_id THEN
      RAISE EXCEPTION 'a seller cannot buy their own item' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.payment_status <> 'pending' OR NEW.refund_status <> 'none' OR NEW.fulfillment_status <> 'unfulfilled'
       OR NEW.payout_eligible OR NEW.refunded_amount_cents <> 0 THEN
      RAISE EXCEPTION 'a new marketplace order must start unpaid and unfulfilled' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.item_snapshot IS NULL OR NEW.seller_snapshot IS NULL
       OR NEW.item_snapshot->>'item_id' IS DISTINCT FROM NEW.marketplace_item_id::text
       OR NEW.seller_snapshot->>'seller_profile_id' IS DISTINCT FROM NEW.seller_id::text THEN
      RAISE EXCEPTION 'marketplace order snapshot does not match the item and seller' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: ownership and the purchase snapshot never change.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_number IS DISTINCT FROM OLD.order_number
     OR NEW.marketplace_item_id IS DISTINCT FROM OLD.marketplace_item_id OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id
     OR NEW.item_price_cents IS DISTINCT FROM OLD.item_price_cents OR NEW.shipping_cents IS DISTINCT FROM OLD.shipping_cents
     OR NEW.platform_fee_bps IS DISTINCT FROM OLD.platform_fee_bps OR NEW.platform_fee_cents IS DISTINCT FROM OLD.platform_fee_cents
     OR NEW.seller_proceeds_cents IS DISTINCT FROM OLD.seller_proceeds_cents
     OR NEW.fulfillment_method IS DISTINCT FROM OLD.fulfillment_method OR NEW.ship_to IS DISTINCT FROM OLD.ship_to
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.is_demo IS DISTINCT FROM OLD.is_demo
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.item_snapshot IS DISTINCT FROM OLD.item_snapshot OR NEW.seller_snapshot IS DISTINCT FROM OLD.seller_snapshot
     OR NEW.pickup_snapshot IS DISTINCT FROM OLD.pickup_snapshot THEN
    RAISE EXCEPTION 'marketplace order % ownership and purchase terms are fixed', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;

  -- Tax, total and the payment reference are set once, while the order is still unpaid.
  IF (NEW.tax_cents IS DISTINCT FROM OLD.tax_cents OR NEW.total_charge_cents IS DISTINCT FROM OLD.total_charge_cents
      OR NEW.stripe_tax_calculation_id IS DISTINCT FROM OLD.stripe_tax_calculation_id) AND OLD.payment_status <> 'pending' THEN
    RAISE EXCEPTION 'marketplace order % totals are fixed after payment', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id AND OLD.stripe_payment_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'marketplace order % payment reference is fixed', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.stripe_charge_id IS DISTINCT FROM OLD.stripe_charge_id AND OLD.stripe_charge_id IS NOT NULL)
     OR (NEW.stripe_tax_transaction_id IS DISTINCT FROM OLD.stripe_tax_transaction_id AND OLD.stripe_tax_transaction_id IS NOT NULL)
     OR (NEW.paid_at IS DISTINCT FROM OLD.paid_at AND OLD.paid_at IS NOT NULL) THEN
    RAISE EXCEPTION 'marketplace order % payment record is fixed', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;

  -- Payment state moves forward only.
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status AND NOT (
       (OLD.payment_status = 'pending'    AND NEW.payment_status IN ('processing','paid','failed','refunded'))
    OR (OLD.payment_status = 'processing' AND NEW.payment_status IN ('paid','failed','refunded'))
    OR (OLD.payment_status = 'failed'     AND NEW.payment_status = 'refunded')     -- a late charge refunded automatically
    OR (OLD.payment_status = 'paid'       AND NEW.payment_status = 'refunded')) THEN
    RAISE EXCEPTION 'marketplace order % payment cannot move from % to %', OLD.order_number, OLD.payment_status, NEW.payment_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Refunds accumulate; never decrease, never exceed the charge, never un-refund.
  IF NEW.refunded_amount_cents < OLD.refunded_amount_cents OR NEW.refunded_amount_cents > GREATEST(NEW.total_charge_cents, OLD.refunded_amount_cents) THEN
    RAISE EXCEPTION 'marketplace order % refunded amount is invalid', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.refund_status IS DISTINCT FROM OLD.refund_status AND NOT (
       (OLD.refund_status = 'none' AND NEW.refund_status IN ('partially_refunded','refunded'))
    OR (OLD.refund_status = 'partially_refunded' AND NEW.refund_status = 'refunded')) THEN
    RAISE EXCEPTION 'marketplace order % refund state cannot move back', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;

  -- Fulfillment moves forward only, only once paid; tracking details are kept once recorded.
  IF NEW.fulfillment_status IS DISTINCT FROM OLD.fulfillment_status THEN
    IF NOT (
         (OLD.fulfillment_status = 'unfulfilled'      AND NEW.fulfillment_status IN ('ready_for_pickup','picked_up','shipped','cancelled'))
      OR (OLD.fulfillment_status = 'ready_for_pickup' AND NEW.fulfillment_status IN ('picked_up','cancelled'))
      OR (OLD.fulfillment_status = 'shipped'          AND NEW.fulfillment_status = 'completed')) THEN
      RAISE EXCEPTION 'marketplace order % fulfillment cannot move from % to %', OLD.order_number, OLD.fulfillment_status, NEW.fulfillment_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.fulfillment_status <> 'cancelled' AND NEW.payment_status <> 'paid' THEN
      RAISE EXCEPTION 'marketplace order % is not paid', OLD.order_number USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (OLD.tracking_number IS NOT NULL AND NEW.tracking_number IS DISTINCT FROM OLD.tracking_number)
     OR (OLD.tracking_carrier IS NOT NULL AND NEW.tracking_carrier IS DISTINCT FROM OLD.tracking_carrier) THEN
    RAISE EXCEPTION 'marketplace order % tracking details are kept as recorded', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;

  -- Payout eligibility: paid, not fully refunded, fulfilled, not on hold.
  IF NEW.payout_eligible AND NOT OLD.payout_eligible AND NOT (
       NEW.payment_status = 'paid' AND NEW.refund_status <> 'refunded' AND NOT NEW.payout_hold
       AND NEW.fulfillment_status IN ('picked_up','completed')) THEN
    RAISE EXCEPTION 'marketplace order % is not eligible for payout', OLD.order_number USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.payout_hold AND NEW.payout_eligible THEN
    NEW.payout_eligible := false;   -- a hold always suspends eligibility (eligibility is a flag; no money moves)
    NEW.payout_eligible_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_marketplace_orders_guard ON marketplace_orders;
CREATE TRIGGER trg_marketplace_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON marketplace_orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_orders_guard();

-- ── Order history: append-only, always naming the order's real seller and buyer ───────────────────────
CREATE TABLE IF NOT EXISTS marketplace_order_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL,
  seller_id      UUID NOT NULL,
  buyer_user_id  UUID NOT NULL,
  event_type     TEXT NOT NULL,           -- created | paid | released | fulfillment | refund | dispute | issue | payout_hold …
  actor_user_id  UUID,                    -- NULL = the platform (payment processor events, sweeper)
  actor_role     TEXT NOT NULL CHECK (actor_role IN ('buyer','seller','admin','system')),
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_demo        BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_marketplace_order_events_parties FOREIGN KEY (order_id, seller_id, buyer_user_id)
    REFERENCES marketplace_orders (id, seller_id, buyer_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_events_order ON marketplace_order_events (order_id, created_at);

-- ── Buyer issues (complaints, problems with an order): tied to the order's real seller and buyer ───────
CREATE TABLE IF NOT EXISTS marketplace_order_issues (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL,
  seller_id           UUID NOT NULL,
  buyer_user_id       UUID NOT NULL,
  category            TEXT NOT NULL CHECK (category IN ('not_received','not_as_described','damaged','pickup_problem','refund_request','other')),
  message             TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','seller_responded','resolved','closed')),
  seller_response     TEXT CHECK (seller_response IS NULL OR length(seller_response) <= 4000),
  seller_responded_at TIMESTAMPTZ,
  seller_responded_by UUID,
  resolution_note     TEXT,
  resolved_by         UUID,
  resolved_at         TIMESTAMPTZ,
  is_demo             BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_marketplace_order_issues_parties FOREIGN KEY (order_id, seller_id, buyer_user_id)
    REFERENCES marketplace_orders (id, seller_id, buyer_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_issues_order  ON marketplace_order_issues (order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_issues_seller ON marketplace_order_issues (seller_id, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_issues_buyer  ON marketplace_order_issues (buyer_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION marketplace_order_children_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.is_demo := COALESCE((SELECT o.is_demo FROM marketplace_orders o WHERE o.id = NEW.order_id), false);   -- never caller-supplied
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_demo THEN RETURN OLD; END IF;
    RAISE EXCEPTION '% rows are kept permanently', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'marketplace_order_events' THEN
    RAISE EXCEPTION 'order history is append-only' USING ERRCODE = 'check_violation';
  END IF;
  -- Issues: the parties and the buyer's own words never change; only status/response/resolution move.
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.message IS DISTINCT FROM OLD.message OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.is_demo IS DISTINCT FROM OLD.is_demo THEN
    RAISE EXCEPTION 'an order issue keeps its order, parties and message' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_marketplace_order_events_guard ON marketplace_order_events;
CREATE TRIGGER trg_marketplace_order_events_guard BEFORE INSERT OR UPDATE OR DELETE ON marketplace_order_events
  FOR EACH ROW EXECUTE FUNCTION marketplace_order_children_guard();
DROP TRIGGER IF EXISTS trg_marketplace_order_issues_guard ON marketplace_order_issues;
CREATE TRIGGER trg_marketplace_order_issues_guard BEFORE INSERT OR UPDATE OR DELETE ON marketplace_order_issues
  FOR EACH ROW EXECUTE FUNCTION marketplace_order_children_guard();

-- ── Chargebacks on storefront orders: linked to the order AND its real seller ─────────────────────────
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS marketplace_order_id UUID;
ALTER TABLE payment_disputes ADD COLUMN IF NOT EXISTS marketplace_seller_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_marketplace_orders_id_seller') THEN
    ALTER TABLE marketplace_orders ADD CONSTRAINT uq_marketplace_orders_id_seller UNIQUE (id, seller_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_disputes_marketplace_order') THEN
    ALTER TABLE payment_disputes ADD CONSTRAINT fk_payment_disputes_marketplace_order
      FOREIGN KEY (marketplace_order_id, marketplace_seller_id) REFERENCES marketplace_orders (id, seller_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_payment_disputes_marketplace_order ON payment_disputes (marketplace_order_id) WHERE marketplace_order_id IS NOT NULL;
