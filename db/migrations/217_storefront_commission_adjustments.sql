-- 217_storefront_commission_adjustments.sql — Storefront Fee corrections (Seller Agreement §6.9, version 4; 2026-11-04).
--
-- A seller may ask for a review of a sale's Website Sale / Marketplace Sale classification within 60 days after the payout
-- that included it. When Advantage.Bid verifies an error, an administrator records a correction here. The correction is
-- applied to, and shown on, the seller's next storefront payout statement.
--   • The order keeps the channel and fee it was created with (migration 215 fixes them), so the original classification
--     and its correction both stand in the record. A later correction of a correction starts from the previous one.
--   • amount_cents is signed: positive = owed TO the seller (the fee charged was too high), negative = owed BY the seller.
--     It always equals from_fee_cents - to_fee_cents (database rule).
--   • Append-only: a correction is never edited or deleted. Only its application to a payout is set (prepareWeek) and
--     cleared again if that payout is voided before it is paid.
--   • storefront_payouts.adjustment_cents = the signed total of the corrections applied to that payout.
-- Reverse: DROP TABLE storefront_commission_adjustments; DROP FUNCTION storefront_commission_adjustments_append_only();
--          ALTER TABLE storefront_payouts DROP COLUMN adjustment_cents;

CREATE TABLE IF NOT EXISTS storefront_commission_adjustments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_order_id   UUID NOT NULL REFERENCES marketplace_orders(id),
  seller_profile_id      UUID NOT NULL REFERENCES seller_profiles(id),
  kind                   TEXT NOT NULL DEFAULT 'channel_reclassification' CHECK (kind IN ('channel_reclassification')),
  from_channel           TEXT NOT NULL CHECK (from_channel IN ('seller_website', 'marketplace')),
  to_channel             TEXT NOT NULL CHECK (to_channel IN ('seller_website', 'marketplace')),
  fee_base_cents         INTEGER NOT NULL CHECK (fee_base_cents >= 0),
  from_fee_bps           INTEGER NOT NULL CHECK (from_fee_bps >= 0),
  to_fee_bps             INTEGER NOT NULL CHECK (to_fee_bps >= 0),
  from_fee_cents         INTEGER NOT NULL CHECK (from_fee_cents >= 0),
  to_fee_cents           INTEGER NOT NULL CHECK (to_fee_cents >= 0),
  amount_cents           INTEGER NOT NULL CHECK (amount_cents <> 0),
  reason                 TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  seller_requested_on    DATE NOT NULL,
  outside_review_window  BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id     UUID NOT NULL REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_payout_id      UUID REFERENCES storefront_payouts(id),
  applied_at             TIMESTAMPTZ,
  CONSTRAINT storefront_commission_adjustments_channel_changes CHECK (from_channel <> to_channel),
  CONSTRAINT storefront_commission_adjustments_amount_matches CHECK (amount_cents = from_fee_cents - to_fee_cents)
);
CREATE INDEX IF NOT EXISTS idx_storefront_commission_adjustments_order ON storefront_commission_adjustments (marketplace_order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_storefront_commission_adjustments_open ON storefront_commission_adjustments (seller_profile_id, created_at)
  WHERE applied_payout_id IS NULL;

CREATE OR REPLACE FUNCTION storefront_commission_adjustments_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'storefront commission corrections are permanent records' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.marketplace_order_id, NEW.seller_profile_id, NEW.kind, NEW.from_channel, NEW.to_channel, NEW.fee_base_cents,
      NEW.from_fee_bps, NEW.to_fee_bps, NEW.from_fee_cents, NEW.to_fee_cents, NEW.amount_cents, NEW.reason, NEW.seller_requested_on,
      NEW.outside_review_window, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.marketplace_order_id, OLD.seller_profile_id, OLD.kind, OLD.from_channel, OLD.to_channel, OLD.fee_base_cents,
      OLD.from_fee_bps, OLD.to_fee_bps, OLD.from_fee_cents, OLD.to_fee_cents, OLD.amount_cents, OLD.reason, OLD.seller_requested_on,
      OLD.outside_review_window, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a storefront commission correction cannot be changed; record a further correction instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_storefront_commission_adjustments_append_only ON storefront_commission_adjustments;
CREATE TRIGGER trg_storefront_commission_adjustments_append_only BEFORE UPDATE OR DELETE ON storefront_commission_adjustments
  FOR EACH ROW EXECUTE FUNCTION storefront_commission_adjustments_append_only();

ALTER TABLE storefront_payouts ADD COLUMN IF NOT EXISTS adjustment_cents INTEGER NOT NULL DEFAULT 0;
