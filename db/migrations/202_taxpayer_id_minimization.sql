-- 202: Taxpayer-ID minimisation (owner decision 2026-10-16; roadmap §8.6). Advantage.Bid does NOT store complete EINs:
-- taxpayer identification is collected and verified by the payment processor during payout setup (Stripe Connect).
-- Advantage.Bid keeps only a verification status, the source, and at most the last four digits.
--   • seller_identity.ein is kept as a column (nothing dropped, reversible) but may never hold a value again (CHECK).
--     The production pre-check refuses to apply this migration if any row still holds an EIN, so no record is lost.
--   • New status columns; all start empty / 'not_provided'.

ALTER TABLE seller_identity ADD COLUMN IF NOT EXISTS taxpayer_id_status      TEXT NOT NULL DEFAULT 'not_provided';
ALTER TABLE seller_identity ADD COLUMN IF NOT EXISTS taxpayer_id_source      TEXT;
ALTER TABLE seller_identity ADD COLUMN IF NOT EXISTS taxpayer_id_last4       TEXT;
ALTER TABLE seller_identity ADD COLUMN IF NOT EXISTS taxpayer_id_verified_at TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_identity_taxpayer_id_status_check') THEN
    ALTER TABLE seller_identity ADD CONSTRAINT seller_identity_taxpayer_id_status_check
      CHECK (taxpayer_id_status IN ('not_provided','pending','verified','unverified'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_identity_taxpayer_id_source_check') THEN
    ALTER TABLE seller_identity ADD CONSTRAINT seller_identity_taxpayer_id_source_check
      CHECK (taxpayer_id_source IS NULL OR taxpayer_id_source IN ('stripe_connect'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_identity_taxpayer_last4_format') THEN
    ALTER TABLE seller_identity ADD CONSTRAINT seller_identity_taxpayer_last4_format
      CHECK (taxpayer_id_last4 IS NULL OR taxpayer_id_last4 ~ '^[0-9]{4}$');
  END IF;
  -- No complete EIN is ever stored by Advantage.Bid.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_identity_no_full_ein') THEN
    ALTER TABLE seller_identity ADD CONSTRAINT seller_identity_no_full_ein CHECK (ein IS NULL);
  END IF;
END $$;
