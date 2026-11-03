-- 216_storefront_agreement_terms_and_refund_fault.sql (owner decisions 2026-11-03)
--
-- 1. Storefront agreement version. agreement_template_versions.storefront_fee_schedule names the storefront commission a
--    Seller Agreement version states ('storefront-2026-11' = 5% website / 9% marketplace). NULL = an earlier version (the
--    old flat 11%). Storefront publishing and storefront sales need a SIGNED version that has it (agreementService.
--    storefrontAgreementStatus); a seller who signed only an earlier version keeps that signature, the dashboard and their
--    auctions. Set automatically from the version's own text (the 5% / 9% section 6.9 defines "Website Sale"), so any way
--    of publishing a version (the publish script or the admin agreements page) marks it the same way. Existing versions
--    are never edited: the backfill below only fills this new column.
-- 2. Refund responsibility. When an administrator refunds a storefront order, who caused it is recorded with the reason
--    ('seller' = seller failure such as not handing over or a material misdescription; 'buyer'; 'platform'; 'other').
--    For a seller-caused refund the order shows the documented nonrefundable card processing cost (processing_fee_cents)
--    as eligible for recovery. Nothing is deducted from any payout unless the owner turns on
--    STOREFRONT_SELLER_FAULT_RECOVERY_ENABLED (off; owner approval and counsel-reviewed seller terms required).
--
-- Rollback (only before any refund records a responsibility):
--   DROP TRIGGER agreement_versions_storefront_terms ON agreement_template_versions; DROP FUNCTION agreement_versions_storefront_terms();
--   ALTER TABLE agreement_template_versions DROP COLUMN storefront_fee_schedule;
--   ALTER TABLE marketplace_orders DROP COLUMN refund_fault, DROP COLUMN refund_fault_note, DROP COLUMN refund_fault_set_by,
--     DROP COLUMN refund_fault_set_at;
--   ALTER TABLE storefront_payout_recoveries DROP COLUMN kind;  (and restore UNIQUE (marketplace_order_id))

CREATE OR REPLACE FUNCTION agreement_versions_storefront_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storefront_fee_schedule IS NULL AND NEW.body_markdown LIKE '%(a "Website Sale")%' THEN
    NEW.storefront_fee_schedule := 'storefront-2026-11';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF to_regclass('agreement_template_versions') IS NOT NULL THEN
    ALTER TABLE agreement_template_versions ADD COLUMN IF NOT EXISTS storefront_fee_schedule TEXT;
    -- (the text column always exists in production; minimal test schemas without it skip the marking)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agreement_template_versions' AND column_name = 'body_markdown') THEN
      UPDATE agreement_template_versions SET storefront_fee_schedule = 'storefront-2026-11'
       WHERE storefront_fee_schedule IS NULL AND body_markdown LIKE '%(a "Website Sale")%';
      DROP TRIGGER IF EXISTS agreement_versions_storefront_terms ON agreement_template_versions;
      CREATE TRIGGER agreement_versions_storefront_terms BEFORE INSERT ON agreement_template_versions
        FOR EACH ROW EXECUTE FUNCTION agreement_versions_storefront_terms();
    END IF;
  END IF;
END $$;

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS refund_fault TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS refund_fault_note TEXT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS refund_fault_set_by UUID;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS refund_fault_set_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_refund_fault_check') THEN
    ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_refund_fault_check
      CHECK (refund_fault IS NULL OR refund_fault IN ('seller', 'buyer', 'platform', 'other'));
  END IF;
END $$;

-- A recovery from a seller has a kind: 'refund' (a refund after the seller was paid, migration 214) or 'processing_fee'
-- (the documented card cost of a seller-caused refund; only created when the switch above is on). One of each per order.
DO $$ BEGIN
  IF to_regclass('storefront_payout_recoveries') IS NOT NULL THEN
    ALTER TABLE storefront_payout_recoveries ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'refund';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_payout_recoveries_kind_check') THEN
      ALTER TABLE storefront_payout_recoveries ADD CONSTRAINT storefront_payout_recoveries_kind_check CHECK (kind IN ('refund', 'processing_fee'));
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storefront_payout_recoveries_marketplace_order_id_key') THEN
      ALTER TABLE storefront_payout_recoveries DROP CONSTRAINT storefront_payout_recoveries_marketplace_order_id_key;
    END IF;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_payout_recoveries_order_kind ON storefront_payout_recoveries (marketplace_order_id, kind);
  END IF;
END $$;
