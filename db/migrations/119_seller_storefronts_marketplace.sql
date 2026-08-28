-- 119: Professional Seller Storefronts + fixed-price Marketplace inventory + auction→marketplace lifecycle.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Introduces the first fixed-price Marketplace inventory table and a
-- storefront presentation layer over EXISTING seller/auction/event/follower data. Does NOT alter auction
-- bidding/close/settlement mechanics, and NEVER mutates historical lot/auction results.

-- ── Storefront config on seller_profiles (the owner of auctions/marketplace/followers) ────────────────
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS storefront_slug      TEXT;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS storefront_published BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS storefront           JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Deterministic default price for an unsold auction lot moved to Marketplace.
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS unsold_price_policy  TEXT NOT NULL DEFAULT 'reserve_or_start';
CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_profiles_storefront_slug ON seller_profiles (lower(storefront_slug)) WHERE storefront_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seller_profiles_storefront_pub ON seller_profiles (storefront_slug) WHERE storefront_published = true;

-- ── Fixed-price Marketplace inventory (the first such table; mirrors auctions.seller_id ownership) ─────
CREATE TABLE IF NOT EXISTS marketplace_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id          UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  -- Linkage back to a source auction lot when converted (nullable for direct listings). Immutable audit.
  source_auction_id  UUID REFERENCES auctions(id) ON DELETE SET NULL,
  source_lot_id      UUID REFERENCES lots(id)     ON DELETE SET NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  category           TEXT,
  condition          TEXT,
  price_cents        INTEGER NOT NULL CHECK (price_cents >= 0),
  images             JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ordered array of image URLs (referenced, not moved)
  thumbnail_url      TEXT,
  city               TEXT,
  state              TEXT,
  zip                TEXT,
  shippable          BOOLEAN NOT NULL DEFAULT false,
  shipping_cost_cents INTEGER,
  shipping_notes     TEXT,
  pickup_group       TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','sold','removed')),
  is_demo            BOOLEAN NOT NULL DEFAULT false,
  converted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  conversion_reason  TEXT,                                  -- 'no_bids' | 'unsold' | 'reserve_not_met' | 'direct'
  converted_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One listing per source lot (idempotent one-button conversion; repeated clicks never duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_items_source_lot ON marketplace_items (source_lot_id) WHERE source_lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketplace_items_seller ON marketplace_items (seller_id, status);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_active ON marketplace_items (status) WHERE status = 'active';

-- ── Storefront consultation / contact inquiries (seller lead inbox; PII protected, seller-scoped) ─────
CREATE TABLE IF NOT EXISTS seller_inquiries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id         UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  name              TEXT,
  email             TEXT,
  phone             TEXT,
  city              TEXT,
  service           TEXT,
  preferred_contact TEXT,
  message           TEXT,
  source_slug       TEXT,
  status            TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','closed')),
  seller_notes      TEXT,
  ip_hash           TEXT,
  is_demo           BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seller_inquiries_seller ON seller_inquiries (seller_id, created_at DESC);
