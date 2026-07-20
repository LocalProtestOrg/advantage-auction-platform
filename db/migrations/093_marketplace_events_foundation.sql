-- 093: Marketplace Events foundation — event field extensions + four membership tiers.
--
-- ADDITIVE ONLY. Idempotent: ADD COLUMN IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING,
-- ALTER ... DROP NOT NULL, and pg_constraint-guarded CHECKs. Safe to re-run.
--
-- Extends the native Events foundation (migration 076) toward Marketplace Event parity per
-- docs/projects/marketplace-events-implementation-plan.md (owner decisions locked 2026-07-20).
-- No changes to auctions/bids/payments/seller_profiles/users.
--
-- Privacy/geocoding columns are ADDED here but their BEHAVIOR (geocode-at-publish, reveal
-- gating) is wired in the Hide-Address-Until increment — following the 076 convention of
-- "columns present, behavior later". The $35 Silver additional-listing FEE is NOT implemented
-- (quota only; charging is a separate, owner + Stripe-gated workflow).

BEGIN;

-- ── 1) Event field extensions ────────────────────────────────────────────────
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type    TEXT;  -- estate_sale|in_person_auction|tag_sale|moving_sale|business_liquidation|other
ALTER TABLE events ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS contact_phone TEXT;

-- Address privacy (Hide Address Until) — behavior wired in the Hide-Address increment.
ALTER TABLE events ADD COLUMN IF NOT EXISTS address_privacy_mode        TEXT NOT NULL DEFAULT 'exact';
ALTER TABLE events ADD COLUMN IF NOT EXISTS address_reveal_trigger      TEXT NOT NULL DEFAULT 'none';
ALTER TABLE events ADD COLUMN IF NOT EXISTS address_reveal_at           TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS address_reveal_hours_before INT;  -- e.g. 24 (BD default)

-- Two-tier geocoding (mirror auctions migration 090): precise internal coords are NEVER
-- exposed publicly; the public lat/lng carry a deterministic privacy-offset marker.
ALTER TABLE events ADD COLUMN IF NOT EXISTS internal_lat                    DOUBLE PRECISION;
ALTER TABLE events ADD COLUMN IF NOT EXISTS internal_lng                    DOUBLE PRECISION;
ALTER TABLE events ADD COLUMN IF NOT EXISTS location_fingerprint           TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS geocoding_status               TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS geocoding_error                TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS geocoding_source               TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS geocoded_at                    TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS coordinates_manually_overridden BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- CHECK constraints (ADD CONSTRAINT is not IF NOT EXISTS-friendly pre-PG16; guard via catalog).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_event_type_chk') THEN
    ALTER TABLE events ADD CONSTRAINT events_event_type_chk
      CHECK (event_type IS NULL OR event_type IN
        ('estate_sale','in_person_auction','tag_sale','moving_sale','business_liquidation','other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_address_privacy_mode_chk') THEN
    ALTER TABLE events ADD CONSTRAINT events_address_privacy_mode_chk
      CHECK (address_privacy_mode IN ('exact','approximate','hidden_until'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_address_reveal_trigger_chk') THEN
    ALTER TABLE events ADD CONSTRAINT events_address_reveal_trigger_chk
      CHECK (address_reveal_trigger IN ('none','on_date','hours_before_start','on_registration','on_approval'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

-- ── 2) Membership plans → four named tiers ───────────────────────────────────
-- NULL now means "unlimited"; 0 means "none". Existing free/standard/premium rows are left
-- intact for backward compatibility; org tiers are assigned via a separate admin path.
ALTER TABLE organization_plans ALTER COLUMN max_event_images  DROP NOT NULL;
ALTER TABLE organization_plans ALTER COLUMN max_active_events DROP NOT NULL;
ALTER TABLE organization_plans ADD COLUMN IF NOT EXISTS max_listings_per_month INT;               -- NULL = unlimited; 0 = none
ALTER TABLE organization_plans ADD COLUMN IF NOT EXISTS search_placement_tier  INT NOT NULL DEFAULT 3;

--  Gold Retailer   : unlimited listings + unlimited photos, tier-1 search placement
--  Silver Retailer : 1 listing / calendar month (+ future $35 addl), 125 photos, tier-2 placement
--  Individual      : one owner-managed sale (1 active), 125 photos
--  Appraiser       : NO Marketplace Event listings (0 listings, 0 photos)
INSERT INTO organization_plans
  (plan_tier, max_event_images, max_active_events, max_listings_per_month, search_placement_tier, can_feature_events) VALUES
  ('gold_retailer',   NULL, NULL, NULL, 1, TRUE),
  ('silver_retailer',  125, NULL,    1, 2, FALSE),
  ('individual',       125,    1, NULL, 3, FALSE),
  ('appraiser',          0,    0,    0, 3, FALSE)
ON CONFLICT (plan_tier) DO NOTHING;

-- ── 3) Capabilities for the membership perks ─────────────────────────────────
INSERT INTO capabilities (key, name, description, sort_order) VALUES
  ('weekly_email_promo', 'Weekly Email Promotion', 'Include listings in the weekly promotional email', 130),
  ('company_badge',      'Company Badge',          'Display the membership badge on the company profile', 140),
  ('company_profile',    'Company Profile',        'Public company profile in the marketplace directory', 150),
  ('lead_generation',    'Lead Generation',        'Buyer lead capture and delivery',                    160)
ON CONFLICT (key) DO NOTHING;

-- ── 4) Plan → capability mapping for the four tiers ──────────────────────────
INSERT INTO plan_capabilities (plan_tier, capability) VALUES
  ('gold_retailer','organizations'),('gold_retailer','events'),('gold_retailer','widgets'),
  ('gold_retailer','weekly_email_promo'),('gold_retailer','company_badge'),
  ('gold_retailer','company_profile'),('gold_retailer','lead_generation'),
  ('silver_retailer','organizations'),('silver_retailer','events'),('silver_retailer','widgets'),
  ('silver_retailer','weekly_email_promo'),('silver_retailer','company_profile'),
  ('individual','organizations'),('individual','events'),('individual','widgets'),
  ('appraiser','organizations'),('appraiser','company_profile')
ON CONFLICT DO NOTHING;

-- Backfill effective grants to any org already on the new tiers (none today; idempotent).
INSERT INTO organization_capabilities (organization_id, capability, source)
SELECT o.id, pc.capability, 'plan'
  FROM organizations o
  JOIN plan_capabilities pc ON pc.plan_tier = o.plan_tier
 WHERE o.plan_tier IN ('gold_retailer','silver_retailer','individual','appraiser')
ON CONFLICT (organization_id, capability) DO NOTHING;

COMMIT;
