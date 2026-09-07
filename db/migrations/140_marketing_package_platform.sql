-- 140_marketing_package_platform.sql — Automated Marketing Package Platform.
-- ADDITIVE + idempotent + production-safe. EXTENDS the existing Marketing Agency (mig 126): reuses
-- marketing_campaigns / marketing_allocations / marketing_ledger / growth_pool / marketing_job_queue /
-- marketing_creative_* / marketing.* config and the internal 60% economics (marketing.direct_spend_max_bps).
--
-- Adds: (1) a VERSIONED package registry (locked identities INCLUDED/FEATURED/PREMIUM/SIGNATURE), (2) a
-- CONFIDENTIAL versioned economic-policy registry, (3) IMMUTABLE package purchase snapshots, (4) Additional
-- Promotion purchase snapshots, (5) the per-deliverable OBLIGATION engine, (6) reservable homepage
-- inventory, and (7) capacity configuration seeds. Prices/deliverables are DATA (versioned) — never
-- hard-coded into business logic. Historical purchases are immutable. Nothing here charges, sends, spends,
-- or flips any external gate.

-- ── 1. Versioned package registry (locked identities; price + deliverables are versioned data) ──
CREATE TABLE IF NOT EXISTS marketing_package_versions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_key            TEXT NOT NULL CHECK (package_key IN ('included','featured','premium','signature')),
  version                INTEGER NOT NULL,
  effective_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to           TIMESTAMPTZ,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  seller_name            TEXT NOT NULL,
  seller_description     TEXT,
  seller_benefits        JSONB NOT NULL DEFAULT '[]',   -- seller-facing bullet list
  guaranteed_deliverables JSONB NOT NULL DEFAULT '[]',  -- [{key,channel,label,qty?}] machine-trackable
  discretionary_tools    JSONB NOT NULL DEFAULT '[]',   -- [{key,channel,label}] best-effort, not guaranteed
  price_cents            INTEGER NOT NULL CHECK (price_cents >= 0),
  economic_policy_version TEXT NOT NULL DEFAULT 'v1',    -- which confidential policy applies at purchase
  capacity_ref           JSONB NOT NULL DEFAULT '{}',   -- e.g. {homepage_days:4}
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pkg_version ON marketing_package_versions(package_key, version);
CREATE INDEX IF NOT EXISTS idx_pkg_active ON marketing_package_versions(package_key, is_active, effective_from DESC);

-- ── 2. CONFIDENTIAL versioned economic-policy registry (NEVER seller-facing) ──
CREATE TABLE IF NOT EXISTS marketing_economic_policies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version         TEXT NOT NULL UNIQUE,
  effective_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to           TIMESTAMPTZ,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  direct_fulfillment_bps INTEGER NOT NULL CHECK (direct_fulfillment_bps >= 0 AND direct_fulfillment_bps <= 10000), -- internal ceiling (60% = 6000). CONFIDENTIAL.
  notes                  TEXT,
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 3. IMMUTABLE package purchase snapshots (authoritative successful-payment only) ──
CREATE TABLE IF NOT EXISTS marketing_package_purchases (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  auction_id              UUID REFERENCES auctions(id) ON DELETE SET NULL,
  event_id                UUID,
  package_key             TEXT NOT NULL CHECK (package_key IN ('featured','premium','signature')), -- INCLUDED is $0, not purchased
  package_version         INTEGER NOT NULL,
  amount_paid_cents       INTEGER NOT NULL CHECK (amount_paid_cents >= 0),   -- ACTUAL paid; drives policy snapshot
  seller_copy             JSONB NOT NULL DEFAULT '{}',   -- frozen name/description/benefits at purchase
  guaranteed_deliverables JSONB NOT NULL DEFAULT '[]',   -- frozen
  discretionary_tools     JSONB NOT NULL DEFAULT '[]',   -- frozen
  economic_policy_version TEXT NOT NULL,                 -- frozen
  direct_fulfillment_bps  INTEGER NOT NULL,              -- frozen policy % (confidential)
  internal_authority_cents INTEGER NOT NULL,             -- derived = amount_paid × bps / 10000 (confidential ceiling)
  status                  TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','void')),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id   TEXT,
  purchased_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NON-REFUNDABLE by policy: no refund/credit columns exist by design.
);
CREATE INDEX IF NOT EXISTS idx_pkg_purchase_seller ON marketing_package_purchases(seller_user_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS idx_pkg_purchase_auction ON marketing_package_purchases(auction_id);

-- ── 4. IMMUTABLE Additional Promotion purchase snapshots (separately paid, separately visible) ──
CREATE TABLE IF NOT EXISTS marketing_additional_promotions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_key           TEXT NOT NULL CHECK (promotion_key IN ('boost','reach','spotlight','custom')),
  version                 INTEGER NOT NULL DEFAULT 1,
  seller_user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  auction_id              UUID REFERENCES auctions(id) ON DELETE SET NULL,
  package_purchase_id     UUID REFERENCES marketing_package_purchases(id) ON DELETE SET NULL, -- non-destructive link
  amount_paid_cents       INTEGER NOT NULL CHECK (amount_paid_cents >= 0),
  benefits                JSONB NOT NULL DEFAULT '[]',
  economic_policy_version TEXT NOT NULL,
  direct_fulfillment_bps  INTEGER NOT NULL,
  internal_authority_cents INTEGER NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','void')),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id   TEXT,
  purchased_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_addl_promo_seller ON marketing_additional_promotions(seller_user_id, purchased_at DESC);

-- ── 5. Per-deliverable OBLIGATION engine (machine-trackable fulfillment) ──
CREATE TABLE IF NOT EXISTS marketing_obligations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_kind  TEXT NOT NULL CHECK (purchase_kind IN ('package','additional_promotion')),
  purchase_id    UUID NOT NULL,                 -- FK-by-convention to the matching purchase table (kind decides which)
  auction_id     UUID REFERENCES auctions(id) ON DELETE SET NULL,
  obligation_key TEXT NOT NULL,                 -- deliverable key from the snapshot
  label          TEXT,
  category       TEXT NOT NULL CHECK (category IN ('guaranteed','discretionary')),
  channel        TEXT NOT NULL,                 -- listing|email|homepage|social|onsite|creative|paid|analytics
  state          TEXT NOT NULL DEFAULT 'planned'
                   CHECK (state IN ('planned','creative_ready','scheduled','live','completed','substituted','made_good','blocked','needs_owner')),
  proof          JSONB NOT NULL DEFAULT '{}',   -- provider/message/edition/homepage/creative/social proof
  substitution_of UUID REFERENCES marketing_obligations(id) ON DELETE SET NULL,
  campaign_id    UUID,                          -- link to marketing_campaigns (mig 126) when planned
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_obligation_purchase ON marketing_obligations(purchase_kind, purchase_id);
CREATE INDEX IF NOT EXISTS idx_obligation_state ON marketing_obligations(state);
-- One row per (purchase, obligation_key) — idempotent obligation creation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_obligation_key ON marketing_obligations(purchase_kind, purchase_id, obligation_key);

-- ── 6. Reservable homepage inventory (module / hero) ──
CREATE TABLE IF NOT EXISTS marketing_homepage_reservations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id UUID REFERENCES marketing_obligations(id) ON DELETE SET NULL,
  auction_id   UUID REFERENCES auctions(id) ON DELETE SET NULL,
  slot_type    TEXT NOT NULL CHECK (slot_type IN ('module','hero')),
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  days         INTEGER NOT NULL CHECK (days > 0),
  status       TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','live','completed','released')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_homepage_dates CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_homepage_res_slot ON marketing_homepage_reservations(slot_type, start_date, end_date);

-- ── 7. Capacity configuration seeds (operational SEEDS, not business constants) ──
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.pkg.shared_email.target_auctions',       '4'::jsonb,   'marketing'),
  ('marketing.pkg.shared_email.normal_max',            '6'::jsonb,   'marketing'),
  ('marketing.pkg.shared_email.editions_per_market_week','2'::jsonb, 'marketing'),
  ('marketing.pkg.dedicated_email.max_per_market_week', '2'::jsonb,  'marketing'),
  ('marketing.pkg.dedicated_email.global_max_per_day',  '3'::jsonb,  'marketing'),
  ('marketing.pkg.dedicated_email.overlap_spacing_hours','48'::jsonb,'marketing'),
  ('marketing.pkg.dedicated_email.audience_floor',      '300'::jsonb,'marketing'),
  ('marketing.pkg.homepage.hero_days',                 '2'::jsonb,   'marketing'),
  ('marketing.pkg.homepage.module_days',               '4'::jsonb,   'marketing'),
  ('marketing.pkg.quote_lock_minutes',                 '30'::jsonb,  'marketing'),
  ('marketing.pkg.version_activation_lead_hours',      '24'::jsonb,  'marketing'),
  -- Stripe price ids for package/promotion checkout (TEST). Empty until Owner sets them; checkout uses
  -- dynamic price_data from the versioned registry when a price id is absent, so this is optional.
  ('marketing.pkg.enabled',                            'true'::jsonb,'marketing'),
  -- Additional Promotion launch preset prices (configurable/versioned; CUSTOM requires an explicit amount).
  ('marketing.pkg.addl.boost.price_cents',             '4900'::jsonb, 'marketing'),
  ('marketing.pkg.addl.reach.price_cents',             '9900'::jsonb, 'marketing'),
  ('marketing.pkg.addl.spotlight.price_cents',         '19900'::jsonb,'marketing')
ON CONFLICT (key) DO NOTHING;

-- ── 8. Seed v1 economic policy (60% internal direct-fulfillment ceiling — CONFIDENTIAL) ──
INSERT INTO marketing_economic_policies (policy_version, direct_fulfillment_bps, notes)
VALUES ('v1', 6000, 'Launch policy: 60% internal direct-fulfillment ceiling (confidential; mirrors marketing.direct_spend_max_bps).')
ON CONFLICT (policy_version) DO NOTHING;

-- ── 9. Seed v1 package versions (LAUNCH prices/deliverables — versioned data, not constants) ──
INSERT INTO marketing_package_versions
  (package_key, version, seller_name, seller_description, seller_benefits, guaranteed_deliverables, discretionary_tools, price_cents, economic_policy_version, capacity_ref)
VALUES
  ('included', 1, 'Included',
   'Standard marketplace listing and discovery for every auction.',
   '["Marketplace listing & discovery","Follower launch notification (where applicable)","Standard analytics"]',
   '[{"key":"marketplace_listing","channel":"listing","label":"Marketplace listing & discovery"},{"key":"follower_launch","channel":"email","label":"Follower launch notification"},{"key":"standard_analytics","channel":"analytics","label":"Standard analytics"}]',
   '[{"key":"roundup_cross_promo","channel":"onsite","label":"Roundup / onsite cross-promotion"}]',
   0, 'v1', '{}'),
  ('featured', 1, 'Featured',
   'Stand out in the marketplace with priority placement, a spotlight on your notable lots, and share-ready creative.',
   '["Everything in Included","Featured badge & listing priority","Category prominence","Notable-lots spotlight (up to 3)","Closing Soon placement","Auction collage creative (1:1 + 4:5)","Seller share assets","Standard analytics + campaign window"]',
   '[{"key":"featured_badge","channel":"listing","label":"Featured badge & listing priority"},{"key":"category_prominence","channel":"listing","label":"Category prominence"},{"key":"notable_lots_spotlight","channel":"onsite","label":"Notable-lots spotlight","qty":3},{"key":"closing_soon_placement","channel":"onsite","label":"Closing Soon placement"},{"key":"collage_creative","channel":"creative","label":"General auction collage (1:1 + 4:5)"},{"key":"seller_share_assets","channel":"creative","label":"Seller share assets"},{"key":"standard_analytics","channel":"analytics","label":"Standard analytics + campaign window"}]',
   '[{"key":"targeted_onsite","channel":"onsite","label":"Targeted onsite"},{"key":"roundup","channel":"onsite","label":"Roundup"},{"key":"organic_facebook","channel":"social","label":"Organic Facebook when cadence allows"}]',
   9900, 'v1', '{}'),
  ('premium', 1, 'Premium',
   'A full campaign with a reserved homepage feature, inclusion in an Advantage.Bid auction email to eligible subscribers, an organic social post, and a catalog readiness review.',
   '["Everything in Featured","Reserved homepage feature/module run","Featured in an Advantage.Bid auction email to eligible subscribers","One organic social post","Closing creative","Catalog readiness review with written recommendations","Detailed analytics"]',
   '[{"key":"homepage_module","channel":"homepage","label":"Reserved homepage feature/module run","days":4},{"key":"shared_email","channel":"email","label":"Featured in an Advantage.Bid auction email to eligible subscribers"},{"key":"organic_social_post","channel":"social","label":"One organic social post","qty":1},{"key":"closing_creative","channel":"creative","label":"Closing creative"},{"key":"catalog_readiness_review","channel":"analytics","label":"Catalog readiness review with written recommendations"},{"key":"detailed_analytics","channel":"analytics","label":"Detailed analytics"}]',
   '[{"key":"local_regional_email","channel":"email","label":"Local/regional email"},{"key":"interest_email","channel":"email","label":"Interest email"},{"key":"behavioral_onsite","channel":"onsite","label":"Behavioral onsite"},{"key":"final_days_email","channel":"email","label":"Final-days email"},{"key":"paid_local_boost","channel":"paid","label":"Paid local boost when appropriate"}]',
   24900, 'v1', '{"homepage_module_days":4}'),
  ('signature', 1, 'Signature',
   'Our top-tier managed campaign: reserved homepage hero days, a dedicated single-auction Advantage.Bid e-blast, multi-wave social, specific-lot creatives, a managed plan with mid-campaign review, and a closing report.',
   '["Everything in Premium","Reserved homepage hero days","Dedicated single-auction Advantage.Bid e-blast","Shared-edition card (inherited from Premium)","3 specific-lot creatives","Mid-campaign creative refresh","Professionally managed campaign plan","Mid-campaign review","Closing report","Pro Seller co-branding (where applicable)","3 social posts across 3 waves","Interest/past-bidder email (where eligible audience exists)","Detailed reporting + written recommendations"]',
   '[{"key":"homepage_hero","channel":"homepage","label":"Reserved homepage hero days","days":2},{"key":"dedicated_email","channel":"email","label":"Dedicated single-auction Advantage.Bid e-blast"},{"key":"shared_email","channel":"email","label":"Shared-edition card (inherited from Premium)"},{"key":"lot_creatives","channel":"creative","label":"3 specific-lot creatives","qty":3},{"key":"mid_campaign_refresh","channel":"creative","label":"Mid-campaign creative refresh"},{"key":"managed_campaign_plan","channel":"analytics","label":"Professionally managed campaign plan"},{"key":"mid_campaign_review","channel":"analytics","label":"Mid-campaign review"},{"key":"closing_report","channel":"analytics","label":"Closing report + written recommendations"},{"key":"social_waves","channel":"social","label":"3 social posts across 3 waves","qty":3},{"key":"interest_email","channel":"email","label":"Interest/past-bidder email (where eligible audience exists)"}]',
   '[{"key":"paid_local_regional_national","channel":"paid","label":"Paid local/regional/national"},{"key":"lot_level_paid","channel":"paid","label":"Lot-level paid promotion"},{"key":"retargeting","channel":"paid","label":"Retargeting when available"},{"key":"google_search","channel":"paid","label":"Google search when available"},{"key":"story_reel","channel":"social","label":"Story/reel where assets exist"},{"key":"aggregator_listings","channel":"listing","label":"Aggregator listings"}]',
   49900, 'v1', '{"homepage_hero_days":2,"waves":["launch","mid","final"]}')
ON CONFLICT (package_key, version) DO NOTHING;
