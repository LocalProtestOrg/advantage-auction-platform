-- 129_marketing_agency_phase4a.sql — Marketing Agency Phase 4A: intelligence runtime + A9/A2 proving.
--
-- ADDITIVE ONLY. Extends the certified 3A/3B foundation (marketing_agents, _campaigns, _qa_reviews,
-- _creative_*, _job_queue, _ledger, growth_pool, growth_markets, settlement_shortfalls). Adds: the full
-- A1–A14 agent registry, the Experiment/Hypothesis contract, the CTA registry (route_verified), the Social
-- Channel registry (dormant), deliverable-fulfillment evidence, and QA severity/verdict columns. Nothing
-- here activates external publishing or spend. NO duplicate queue/ledger/growth/settlement is created.
--
-- RECONCILIATION (3C/3D/3E vs production): queue=EXISTS(marketing_job_queue), ledger=EXISTS(marketing_ledger),
-- growth+authority=EXISTS(growth_pool/_ledger/_monthly_authority), package economics/allocations/eligibility=
-- EXISTS(mig126/127), provenance=EXISTS(marketing_creative_*), QA table=EXISTS(marketing_qa_reviews, extended
-- here), campaigns/radius=EXISTS(marketing_campaigns/_radius_exceptions). ADDED below: A1–A14, experiments,
-- CTAs, social channels, deliverable evidence, QA severity, analytics/brand config.

-- ── A1–A14 agent registry (extend the existing marketing_agents) ─────────────────────
ALTER TABLE marketing_agents ADD COLUMN IF NOT EXISTS code        TEXT;      -- 'A1'..'A14'
ALTER TABLE marketing_agents ADD COLUMN IF NOT EXISTS tier        TEXT;      -- director | qa | creator | growth | ops
ALTER TABLE marketing_agents ADD COLUMN IF NOT EXISTS can_publish BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE marketing_agents ADD COLUMN IF NOT EXISTS can_spend   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE marketing_agents ADD COLUMN IF NOT EXISTS can_review  BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_agents_code ON marketing_agents(code) WHERE code IS NOT NULL;

INSERT INTO marketing_agents (agent_key, code, display_name, tier, capabilities, can_publish, can_spend, can_review) VALUES
  ('a1_director',   'A1',  'Marketing Director',            'director', '["plan","allocate","growth_spend","escalate","propose_experiment","decide_experiment"]', false, true,  false),
  ('a2_qa',         'A2',  'Independent Marketing QA',      'qa',       '["review","approve_release","reject_release","mechanical_correct"]', false, false, true),
  ('a3_creative',   'A3',  'Creative',                      'creator',  '["draft_creative"]', false, false, false),
  ('a4_copy',       'A4',  'Copy',                          'creator',  '["draft_copy"]', false, false, false),
  ('a5_video',      'A5',  'Video',                         'creator',  '["draft_video"]', false, false, false),
  ('a6_social',     'A6',  'Social',                        'creator',  '["draft_social"]', false, false, false),
  ('a7_email',      'A7',  'Email',                         'creator',  '["draft_email"]', false, false, false),
  ('a8_paid',       'A8',  'Paid Media',                    'growth',   '["propose_paid","reserve_budget","propose_experiment"]', false, true,  false),
  ('a9_seo',        'A9',  'SEO / Content',                 'creator',  '["draft_content","build_evidence","propose_experiment"]', false, false, false),
  ('a10_buyer',     'A10', 'Buyer Growth',                  'growth',   '["propose_experiment","propose_audience"]', false, false, false),
  ('a11_indiv',     'A11', 'Individual Seller Growth',      'growth',   '["propose_experiment","propose_audience"]', false, false, false),
  ('a12_pro',       'A12', 'Professional Seller Growth',    'growth',   '["propose_experiment","propose_audience"]', false, false, false),
  ('a13_prospect',  'A13', 'Prospecting',                   'growth',   '["propose_outreach"]', false, false, false),
  ('a14_analytics', 'A14', 'Analytics',                     'ops',      '["read_metrics","evaluate_experiment"]', false, false, false)
ON CONFLICT (agent_key) DO UPDATE SET
  code = EXCLUDED.code, tier = EXCLUDED.tier, display_name = EXCLUDED.display_name,
  capabilities = EXCLUDED.capabilities, can_publish = EXCLUDED.can_publish,
  can_spend = EXCLUDED.can_spend, can_review = EXCLUDED.can_review;

-- ── Experiment / Hypothesis contract ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_experiments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis          TEXT NOT NULL,
  objective           TEXT,
  campaign_class      TEXT,                       -- event_local | buyer | seller | professional_seller | brand | growth
  audience            TEXT,
  market_id           UUID REFERENCES growth_markets(id) ON DELETE SET NULL,
  channels            JSONB NOT NULL DEFAULT '[]',
  proposed_by_agent   TEXT,                       -- agent code (A1/A8/A9/…)
  rationale           TEXT,
  primary_metric      TEXT,
  secondary_metrics   JSONB NOT NULL DEFAULT '[]',
  expected_outcome    TEXT,
  budget_cents        INTEGER NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  reservation_id      UUID,                       -- links to a committed marketing_ledger reservation when paid
  starts_at           TIMESTAMPTZ,
  review_at           TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','running','measuring','decided','abandoned')),
  observations        TEXT,
  decision            TEXT CHECK (decision IN ('expand','repeat','modify','pause','abandon') OR decision IS NULL),
  confidence          TEXT,                       -- evidence strength (low|medium|high|…)
  within_authority    BOOLEAN NOT NULL DEFAULT true,   -- false → requires Owner approval before running
  links               JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_experiments_status ON marketing_experiments(status);

-- ── Full-Circle CTA registry (route_verified gate) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_ctas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cta_key        TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('primary','secondary_seller_acquisition')),
  label          TEXT NOT NULL,
  href           TEXT NOT NULL,                   -- clean canonical path (no tracking/AI params)
  route_verified BOOLEAN NOT NULL DEFAULT false,  -- must be true before an asset may use it
  verified_at    TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO marketing_ctas (cta_key, kind, label, href) VALUES
  ('view_auction',        'primary',                      'View the auction',        '/search.html?mode=auctions&status=active'),
  ('browse_estate_sales', 'primary',                      'Browse estate sales',     '/events.html'),
  ('how_it_works',        'primary',                      'How it works',            '/how-it-works.html'),
  ('start_selling',       'secondary_seller_acquisition', 'Start selling',           '/start-selling.html'),
  ('sell_professionally', 'secondary_seller_acquisition', 'Sell professionally',     '/professional-sellers.html')
ON CONFLICT (cta_key) DO NOTHING;

-- ── Social Channel registry (BUILD, do not connect) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_social_channels (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key        TEXT NOT NULL UNIQUE,
  platform           TEXT NOT NULL,               -- facebook | instagram | …
  display_name       TEXT NOT NULL,
  origin             TEXT NOT NULL DEFAULT 'pre_existing',   -- pre_existing | created_by_agency
  lifecycle          TEXT NOT NULL DEFAULT 'authorization_required'
                       CHECK (lifecycle IN ('authorization_required','authorized','active','paused','disabled')),
  secret_ref         TEXT,                        -- reference ONLY (never a credential); NULL until owner connects
  agent_publish_enabled BOOLEAN NOT NULL DEFAULT false,   -- A6 external publishing stays OFF this phase
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO marketing_social_channels (channel_key, platform, display_name, origin, lifecycle) VALUES
  ('advantage_bid_facebook', 'facebook', 'Advantage.Bid (official Facebook)', 'pre_existing', 'authorization_required')
ON CONFLICT (channel_key) DO NOTHING;

-- ── Deliverable fulfillment evidence (an intended post is NOT fulfillment) ───────────
CREATE TABLE IF NOT EXISTS marketing_deliverable_evidence (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marketing_job_id UUID REFERENCES marketing_jobs(id) ON DELETE CASCADE,
  campaign_id      UUID REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  feature_key      TEXT NOT NULL,                 -- e.g. 'social_promotion','email_campaign','featured_placement'
  verification     TEXT NOT NULL DEFAULT 'manual_verified'
                     CHECK (verification IN ('manual_verified','provider_verified')),
  evidence_url     TEXT,
  evidence_ref     TEXT,
  verified_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deliverable_evidence_job ON marketing_deliverable_evidence(marketing_job_id);

-- ── A2 QA runtime: severity + structured verdict on the existing marketing_qa_reviews ─
ALTER TABLE marketing_qa_reviews ADD COLUMN IF NOT EXISTS severity       TEXT;   -- highest severity found: S1..S6 (null=clean)
ALTER TABLE marketing_qa_reviews ADD COLUMN IF NOT EXISTS verdict        JSONB;  -- structured findings array
ALTER TABLE marketing_qa_reviews ADD COLUMN IF NOT EXISTS claim_manifest JSONB;  -- claims verified against source fields
ALTER TABLE marketing_qa_reviews ADD COLUMN IF NOT EXISTS disposition    TEXT;   -- release_ready | return_to_producer | mechanically_corrected
ALTER TABLE marketing_qa_reviews ADD COLUMN IF NOT EXISTS producer_agent TEXT;   -- who authored (independence check)

-- ── Config: Tier-3 language version, analytics allowlist, QA/full-circle flags ───────
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.brand_language_version',     '"tier3-v1"'::jsonb, 'marketing'),
  ('marketing.analytics.standard_allowlist', '["gross_revenue_cents","sold_lots","total_lots","unique_buyers_count","seller_payout_cents","platform_fee_cents","processing_fee_cents"]'::jsonb, 'marketing'),
  ('marketing.analytics.detailed_allowlist', '["gross_revenue_cents","sold_lots","total_lots","unsold_lots","unique_buyers_count","highest_sale_cents","seller_payout_cents","platform_fee_cents","processing_fee_cents","buyer_premium_cents"]'::jsonb, 'marketing'),
  ('marketing.a9_publish_enabled',         'false'::jsonb, 'marketing'),
  ('marketing.full_circle_required',       'true'::jsonb,  'marketing')
ON CONFLICT (key) DO NOTHING;

-- ── Premium email promise (item 12): retire "Email campaign (10,000+ subscribers)" in the CURRENT package
-- OFFERING (forward-looking product copy). This does NOT rewrite any historical purchase (marketing_jobs);
-- those obligations are preserved and reported separately. Only updates the active template's features text.
UPDATE marketing_packages
   SET features = replace(features::text, 'Email campaign (10,000+ subscribers)', 'Dedicated Advantage.Bid email campaign to eligible subscribers')::jsonb,
       updated_at = now()
 WHERE features::text LIKE '%Email campaign (10,000+ subscribers)%';
