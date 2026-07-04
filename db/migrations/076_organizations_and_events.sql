-- 076: Organizations foundation + Events product (Phase 1).
--
-- Establishes the foundational ORGANIZATION business layer (organizations, members,
-- plans) and the first product built on it — EVENTS (events, images, markets,
-- categories). Railway/AAC is the source of truth; Brilliant Directories only
-- displays published events via the public read-only API.
--
-- ADDITIVE ONLY. New tables only. This migration does NOT alter or drop any existing
-- table — no changes to auctions, bids, payments, seller_profiles, or users. FK targets
-- (users.id, seller_profiles.id) are pre-existing UUID PKs from 001_create_schema.sql.
-- gen_random_uuid() is provided by pgcrypto (created in 001). No payments/Stripe/tax/
-- premium/settlement changes. Spec: docs/projects/local-events-architecture.md.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS + seed INSERT ... ON CONFLICT DO NOTHING.
-- Deferred (columns present, behavior later): verification workflow, recurrence, geo/
-- polygon markets, imports, paid promotions. See spec §12–§13.

-- ── Organization plans (config; limits enforced server-side) ──────────────────
CREATE TABLE IF NOT EXISTS organization_plans (
  plan_tier          TEXT PRIMARY KEY,                      -- 'free','standard','premium'
  max_event_images   INT NOT NULL,
  max_active_events  INT NOT NULL,
  can_feature_events BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO organization_plans (plan_tier, max_event_images, max_active_events, can_feature_events) VALUES
  ('free',     10,  3, FALSE),
  ('standard', 25, 10, FALSE),
  ('premium',  50, 25, TRUE)
ON CONFLICT (plan_tier) DO NOTHING;

-- ── Organizations (the foundational business entity) ──────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  type                TEXT,                                 -- descriptive: auction_company|estate_sale|antique_dealer|event_organizer|other
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended')),
  plan_tier           TEXT NOT NULL DEFAULT 'free' REFERENCES organization_plans(plan_tier),
  -- organizer verification (trust signal; Phase 1 defaults to unverified → "Community Organizer")
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','community','verified')),
  verified_at         TIMESTAMPTZ,
  verified_by         UUID REFERENCES users(id),
  -- profile / contact
  contact_email       TEXT,
  contact_phone       TEXT,
  website_url         TEXT,
  logo_url            TEXT,
  city                TEXT,
  state               TEXT,
  -- optional future link to the auction-seller identity (nullable; backfilled later)
  seller_profile_id   UUID REFERENCES seller_profiles(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_organizations_seller_profile ON organizations(seller_profile_id);

-- ── Organization members (multi-user ready; Phase 1 uses 'owner' only) ────────
CREATE TABLE IF NOT EXISTS organization_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  role            TEXT NOT NULL DEFAULT 'owner'
                    CHECK (role IN ('owner','admin','editor','member')),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','invited','removed')),
  invited_email   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org  ON organization_members(organization_id);

-- ── Event markets (table-driven; slug-based in P1, geo columns reserved) ───────
CREATE TABLE IF NOT EXISTS event_markets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  -- geographic definition: radius now (optional), polygon later (PostGIS) — no rename needed
  center_lat DOUBLE PRECISION,
  center_lng DOUBLE PRECISION,
  radius_km  INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO event_markets (slug, name, sort_order) VALUES
  ('houston',      'Houston, TX',      1),
  ('nyc_tristate', 'NYC / Tri-State',  2)
ON CONFLICT (slug) DO NOTHING;

-- ── Event categories (event-specific taxonomy) ────────────────────────────────
CREATE TABLE IF NOT EXISTS event_categories (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO event_categories (slug, name, sort_order) VALUES
  ('auctions',            'Auctions',              1),
  ('estate_sales',        'Estate Sales',          2),
  ('art_antiques',        'Art & Antiques',        3),
  ('collectibles',        'Collectibles',          4),
  ('markets_fairs',       'Markets & Fairs',       5),
  ('business_networking', 'Business / Networking', 6),
  ('community',           'Community Events',       7),
  ('other',               'Other',                 8)
ON CONFLICT (slug) DO NOTHING;

-- ── Events (Phase 1 product; 5-state lifecycle) ───────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 TEXT UNIQUE NOT NULL,
  organization_id      UUID REFERENCES organizations(id),      -- null for admin/imported
  source               TEXT NOT NULL DEFAULT 'organization'
                         CHECK (source IN ('organization','admin','imported')),
  market_slug          TEXT NOT NULL REFERENCES event_markets(slug),
  category_slug        TEXT REFERENCES event_categories(slug),
  title                TEXT NOT NULL,
  description          TEXT,
  venue_name           TEXT,
  address              TEXT,
  city                 TEXT,
  state                TEXT,
  zip                  TEXT,
  lat                  DOUBLE PRECISION,                       -- kept for future geo/polygon search
  lng                  DOUBLE PRECISION,
  start_at             TIMESTAMPTZ NOT NULL,
  end_at               TIMESTAMPTZ,
  timezone             TEXT NOT NULL DEFAULT 'America/New_York',
  -- recurrence (schema room only; NOT implemented in Phase 1)
  is_recurring         BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence_type      TEXT,                                   -- none|daily|weekly|monthly|custom
  recurrence_rule      TEXT,                                   -- iCal RRULE (future)
  recurrence_parent_id UUID REFERENCES events(id),            -- materialized instances (future)
  external_url         TEXT,
  -- lifecycle (5 states)
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','submitted','published','rejected','archived')),
  submitted_at         TIMESTAMPTZ,
  published_at         TIMESTAMPTZ,
  reviewed_by          UUID REFERENCES users(id),
  review_reason        TEXT,
  -- monetization scaffolding (Phase 1: columns only, never billed)
  is_featured          BOOLEAN NOT NULL DEFAULT FALSE,
  promo_tier           TEXT,
  promo_starts_at      TIMESTAMPTZ,
  promo_ends_at        TIMESTAMPTZ,
  -- third-party attribution (later phases)
  attribution_source   TEXT,
  attribution_url      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_market_status ON events(market_slug, status);
CREATE INDEX IF NOT EXISTS idx_events_start         ON events(start_at);
CREATE INDEX IF NOT EXISTS idx_events_org           ON events(organization_id);

-- ── Event images (Cloudinary; per-plan limits enforced server-side) ───────────
CREATE TABLE IF NOT EXISTS event_images (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  position   INT NOT NULL DEFAULT 0,
  is_cover   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_images_event ON event_images(event_id);
