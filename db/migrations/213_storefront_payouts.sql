-- 213_storefront_payouts.sql
-- Storefront (fixed-price) sales join seller settlement and payouts (owner priority 2026-11-02; roadmap §13.H).
--
-- One payout record per seller per weekly cutoff (Wednesday 11:59 PM Eastern): it lists the fulfilled, paid, unrefunded,
-- undisputed storefront orders completed before the cutoff, and the seller's proceeds for each (item + shipping minus the
-- flat 11% fee; sales tax is never seller proceeds). Records are PREPARED automatically on Thursday; money moves only when
-- an administrator approves "Pay Seller" (the same rule as auction settlements), by one Stripe transfer to the seller's
-- connected account (idempotency-keyed; transfer webhooks update the status). Auction settlements are unchanged.
--
-- Rollback (only while no storefront payout exists):
--   ALTER TABLE marketplace_orders DROP COLUMN storefront_payout_id, DROP COLUMN settled_at;
--   DROP TABLE storefront_payout_lines; DROP TABLE storefront_payouts;

CREATE TABLE IF NOT EXISTS storefront_payouts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_profile_id       UUID NOT NULL REFERENCES seller_profiles(id),
  seller_user_id          UUID NOT NULL,
  period_cutoff_at        TIMESTAMPTZ NOT NULL,                 -- sales completed before this moment are included
  order_count             INTEGER NOT NULL DEFAULT 0,
  goods_cents             INTEGER NOT NULL DEFAULT 0,          -- item prices + shipping of the included orders
  platform_fee_cents      INTEGER NOT NULL DEFAULT 0,          -- the flat 11% storefront fee on item prices
  seller_payout_cents     INTEGER NOT NULL DEFAULT 0,          -- what the seller is paid
  settlement_status       TEXT NOT NULL DEFAULT 'pending_review'
                          CHECK (settlement_status IN ('pending_review', 'on_hold', 'paid', 'void')),
  on_hold_reason          TEXT,
  void_reason             TEXT,
  payout_status           TEXT NOT NULL DEFAULT 'pending' CHECK (payout_status IN ('pending', 'processing', 'released', 'reversed')),
  stripe_transfer_id      TEXT,
  transfer_initiated_at   TIMESTAMPTZ,
  transfer_failure_message TEXT,
  final_amount_paid_cents INTEGER,
  paid_at                 TIMESTAMPTZ,
  paid_by_user_id         UUID,
  created_by_user_id      UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (seller_payout_cents >= 0)
);
-- One live record per seller per cutoff (a voided one may be prepared again).
CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_payouts_seller_cutoff ON storefront_payouts (seller_profile_id, period_cutoff_at)
  WHERE settlement_status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_payouts_transfer ON storefront_payouts (stripe_transfer_id) WHERE stripe_transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_storefront_payouts_status ON storefront_payouts (settlement_status, period_cutoff_at DESC);

CREATE TABLE IF NOT EXISTS storefront_payout_lines (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storefront_payout_id  UUID NOT NULL REFERENCES storefront_payouts(id),
  marketplace_order_id  UUID NOT NULL REFERENCES marketplace_orders(id),
  order_number          TEXT,
  goods_cents           INTEGER NOT NULL,
  platform_fee_cents    INTEGER NOT NULL,
  amount_cents          INTEGER NOT NULL,
  active                BOOLEAN NOT NULL DEFAULT true,          -- false when its payout was voided (the order may be paid later)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- An order is in at most one live payout: it can never be paid twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_payout_lines_order ON storefront_payout_lines (marketplace_order_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_storefront_payout_lines_payout ON storefront_payout_lines (storefront_payout_id);

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS storefront_payout_id UUID;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

-- ── Owner and Admin/Finance notice when a storefront order is confirmed paid (roadmap §13.G) ──────────────────────────
-- The same outbox as the seller's sale notice (migration 204): one row per paid order per recipient, retried, alerted on
-- final failure. Recipients: active administrators and finance staff with a verified email (rbac roles; managed by admins).
DO $$ BEGIN
  IF to_regclass('storefront_notifications') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_notifications_event_check') THEN
    ALTER TABLE storefront_notifications DROP CONSTRAINT storefront_notifications_event_check;
  END IF;
  ALTER TABLE storefront_notifications ADD CONSTRAINT storefront_notifications_event_check
    CHECK (event IN ('sale_paid','sale_paid_admin','message_to_seller','message_to_buyer'));
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_notifications_subject_check') THEN
    ALTER TABLE storefront_notifications DROP CONSTRAINT storefront_notifications_subject_check;
  END IF;
  ALTER TABLE storefront_notifications ADD CONSTRAINT storefront_notifications_subject_check
    CHECK ((event IN ('sale_paid','sale_paid_admin') AND order_id IS NOT NULL AND message_id IS NULL)
        OR (event IN ('message_to_seller','message_to_buyer') AND message_id IS NOT NULL AND order_id IS NULL));
END $$;
