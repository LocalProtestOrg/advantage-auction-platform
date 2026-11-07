-- 223_paid_campaign_authorizations.sql - Explicit owner authorization records for paid advertising, and attribution
-- groundwork for future seller-authorized auction campaigns. Owner-authorized baseline correction (2026-11-06).
-- Additive only. No historical campaign, ledger, purchase or payment row is changed.
--   1. marketing_paid_authorizations: the owner's written authority for ONE campaign: channel, market, maximum amount,
--      delivery window, the exact creative (and optionally the exact creative package), who authorized it and when it
--      expires. Building, creating or activating paid delivery requires a matching, unexpired, 'authorized' row and may
--      not exceed its amount, dates or creative. Activation consumes it. At most one open authorization per campaign.
--   2. marketing_paid_campaigns: nullable authorization_id plus purchase / auction / seller attribution columns, so a
--      future seller-authorized campaign is attributable to the purchase and auction that paid for it. Existing rows keep
--      NULL in every new column.
--   3. Dedicated email settings: the executor now reads the admin-editable marketing.pkg.dedicated_email.* keys. Any value
--      held under the retired marketing.dedicated.* names is copied across only where the new key is absent (normally a
--      no-op: the retired names were never seeded).
-- Reverse:
--   ALTER TABLE marketing_paid_campaigns DROP COLUMN IF EXISTS authorization_id, DROP COLUMN IF EXISTS purchase_kind,
--     DROP COLUMN IF EXISTS purchase_id, DROP COLUMN IF EXISTS auction_id, DROP COLUMN IF EXISTS seller_profile_id;
--   DROP TABLE IF EXISTS marketing_paid_authorizations;
--   (the copied dedicated email keys may stay; they are the keys the admin page already edits)

CREATE TABLE IF NOT EXISTS marketing_paid_authorizations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_key        TEXT NOT NULL CHECK (length(campaign_key) BETWEEN 1 AND 200),
  channel             TEXT NOT NULL DEFAULT 'meta_ads' CHECK (channel IN ('meta_ads','google_ads')),
  market_key          TEXT,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  starts_at           TIMESTAMPTZ NOT NULL,
  ends_at             TIMESTAMPTZ NOT NULL,
  creative_id         UUID NOT NULL REFERENCES marketing_production_creative(id) ON DELETE RESTRICT,
  creative_asset_key  TEXT,
  package_key         TEXT,
  purchase_kind       TEXT CHECK (purchase_kind IS NULL OR purchase_kind IN ('package','additional_promotion')),
  purchase_id         UUID,
  auction_id          UUID REFERENCES auctions(id) ON DELETE SET NULL,
  seller_profile_id   UUID REFERENCES seller_profiles(id) ON DELETE SET NULL,
  authorized_by       UUID NOT NULL REFERENCES users(id),
  authorized_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'authorized' CHECK (status IN ('authorized','consumed','revoked','expired')),
  consumed_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID REFERENCES users(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mpa_window CHECK (ends_at > starts_at),
  CONSTRAINT chk_mpa_expiry CHECK (expires_at > authorized_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mpa_one_open_per_campaign ON marketing_paid_authorizations (campaign_key) WHERE status = 'authorized';
CREATE INDEX IF NOT EXISTS idx_mpa_campaign ON marketing_paid_authorizations (campaign_key, created_at DESC);

ALTER TABLE marketing_paid_campaigns ADD COLUMN IF NOT EXISTS authorization_id UUID REFERENCES marketing_paid_authorizations(id) ON DELETE SET NULL;
ALTER TABLE marketing_paid_campaigns ADD COLUMN IF NOT EXISTS purchase_kind TEXT CHECK (purchase_kind IS NULL OR purchase_kind IN ('package','additional_promotion'));
ALTER TABLE marketing_paid_campaigns ADD COLUMN IF NOT EXISTS purchase_id UUID;
ALTER TABLE marketing_paid_campaigns ADD COLUMN IF NOT EXISTS auction_id UUID REFERENCES auctions(id) ON DELETE SET NULL;
ALTER TABLE marketing_paid_campaigns ADD COLUMN IF NOT EXISTS seller_profile_id UUID REFERENCES seller_profiles(id) ON DELETE SET NULL;

INSERT INTO platform_config (key, value, category)
SELECT m.new_key, p.value, 'marketing'
  FROM (VALUES ('marketing.dedicated.audience_floor', 'marketing.pkg.dedicated_email.audience_floor'),
               ('marketing.dedicated.max_per_market_week', 'marketing.pkg.dedicated_email.max_per_market_week'),
               ('marketing.dedicated.max_per_day', 'marketing.pkg.dedicated_email.global_max_per_day'),
               ('marketing.dedicated.spacing_hours', 'marketing.pkg.dedicated_email.overlap_spacing_hours')) AS m(old_key, new_key)
  JOIN platform_config p ON p.key = m.old_key
ON CONFLICT (key) DO NOTHING;
