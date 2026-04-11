-- Migration: 001_create_schema.sql
-- Creates initial schema for Advantage Auction Platform (Phase 1)

-- Enable uuid generator
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigger to keep updated_at fresh on UPDATE
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('seller','buyer','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login TIMESTAMPTZ
);

-- seller_profiles
CREATE TABLE IF NOT EXISTS seller_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  seller_type TEXT CHECK (seller_type IN ('business','private','other')),
  capabilities JSONB DEFAULT '{}'::JSONB,
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- campaigns (marketing)
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  tier TEXT,
  fee_cents INTEGER,
  description TEXT,
  admin_notes JSONB DEFAULT '{}'::JSONB
);

-- auctions
CREATE TABLE IF NOT EXISTS auctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID REFERENCES seller_profiles(id) ON DELETE SET NULL,
  title TEXT,
  description TEXT,
  public_auction_type TEXT,
  auction_terms TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  timezone TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  pickup_window_start TIMESTAMPTZ,
  pickup_window_end TIMESTAMPTZ,
  address_encrypted BYTEA,
  state TEXT NOT NULL CHECK (state IN ('draft','submitted','under_review','published','active','closed')) DEFAULT 'draft',
  submitted_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  default_starting_bid_cents INTEGER DEFAULT 100,
  increment_ladder JSONB DEFAULT '[]'::JSONB,
  version INTEGER DEFAULT 1,
  marketing_selection JSONB,
  admin_notes JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auctions_seller ON auctions(seller_id);
CREATE INDEX IF NOT EXISTS idx_auctions_state_start ON auctions(state, start_time);

-- consignors
CREATE TABLE IF NOT EXISTS consignors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE,
  name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- lots
CREATE TABLE IF NOT EXISTS lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE,
  lot_number INTEGER,
  title TEXT,
  description TEXT,
  size_category TEXT CHECK (size_category IN ('A','B','C')),
  dimensions JSONB,
  images_count INTEGER DEFAULT 0,
  thumbnail_url TEXT,
  is_withdrawn BOOLEAN DEFAULT FALSE,
  state TEXT CHECK (state IN ('open','withdrawn','closed')) DEFAULT 'open',
  is_featured BOOLEAN DEFAULT FALSE,
  starting_bid_cents INTEGER,
  current_bid_cents INTEGER,
  bid_count INTEGER DEFAULT 0,
  closes_at TIMESTAMPTZ,
  extended_until TIMESTAMPTZ,
  soft_close_extension_count INTEGER DEFAULT 0,
  soft_close_policy JSONB,
  shippable BOOLEAN DEFAULT FALSE,
  shipping_cost_cents INTEGER,
  shipping_notes TEXT,
  pickup_group TEXT CHECK (pickup_group IN ('A_group','B_group','C_group','mixed')),
  reserve_cents INTEGER,
  reserve_visible BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure lot_number is unique per auction
ALTER TABLE IF EXISTS lots
  ADD CONSTRAINT IF NOT EXISTS uq_lots_auction_lot_number UNIQUE (auction_id, lot_number);

CREATE INDEX IF NOT EXISTS idx_lots_auction_lotnum ON lots(auction_id, lot_number);
CREATE INDEX IF NOT EXISTS idx_lots_closes_at ON lots(closes_at);

-- images
CREATE TABLE IF NOT EXISTS images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  url TEXT,
  storage_key TEXT,
  width INTEGER,
  height INTEGER,
  checksum TEXT,
  status TEXT CHECK (status IN ('pending','processed','failed')) DEFAULT 'pending',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- auction_buyers
CREATE TABLE IF NOT EXISTS auction_buyers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  paddle_number INTEGER NOT NULL,
  interests JSONB DEFAULT '[]'::JSONB,
  newsletter_prefs JSONB DEFAULT '{}'::JSONB,
  registration_history JSONB DEFAULT '[]'::JSONB,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (auction_id, paddle_number)
);

-- bids
CREATE TABLE IF NOT EXISTS bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_proxy BOOLEAN DEFAULT FALSE,
  paddle_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index to support recent-bids-by-lot queries (bidding performance)
CREATE INDEX IF NOT EXISTS idx_bids_lot_time ON bids(lot_id, timestamp DESC);

-- card_verifications
CREATE TABLE IF NOT EXISTS card_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  card_id UUID,
  attempt_charge_id TEXT,
  amount_cents INTEGER,
  currency TEXT,
  status TEXT CHECK (status IN ('pending','verified','failed','refunded')) DEFAULT 'pending',
  attempted_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  refund_txn_id TEXT
);

-- payments
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE,
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  buyer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  status TEXT CHECK (status IN ('pending','paid','failed','refunded','partially_refunded')) DEFAULT 'pending',
  charged_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  payment_provider_id TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index to support payments lookup by lot and status
CREATE INDEX IF NOT EXISTS idx_payments_lot_status ON payments(lot_id, status);

-- marketing_profiles
CREATE TABLE IF NOT EXISTS marketing_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  buyer_interests JSONB DEFAULT '[]'::JSONB,
  keyword_interests JSONB DEFAULT '[]'::JSONB,
  newsletter_prefs JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- pickup_schedules
CREATE TABLE IF NOT EXISTS pickup_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID REFERENCES auctions(id) UNIQUE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  schedule JSONB,
  admin_overridden BOOLEAN DEFAULT FALSE,
  admin_override_by UUID REFERENCES users(id),
  admin_override_at TIMESTAMPTZ
);

-- pickup_assignments
CREATE TABLE IF NOT EXISTS pickup_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pickup_schedule_id UUID REFERENCES pickup_schedules(id) ON DELETE CASCADE,
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  buyer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  slot_start TIMESTAMPTZ,
  slot_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- admin_action_logs
CREATE TABLE IF NOT EXISTS admin_action_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  auction_id UUID,
  lot_id UUID,
  action TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Triggers to auto-update `updated_at` columns where present
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_auctions_updated_at') THEN
    CREATE TRIGGER trg_auctions_updated_at
    BEFORE UPDATE ON auctions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_lots_updated_at') THEN
    CREATE TRIGGER trg_lots_updated_at
    BEFORE UPDATE ON lots
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_marketing_profiles_updated_at') THEN
    CREATE TRIGGER trg_marketing_profiles_updated_at
    BEFORE UPDATE ON marketing_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END$$;

-- Create named triggers if they don't already exist (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_auctions_updated_at') THEN
    CREATE TRIGGER update_auctions_updated_at
    BEFORE UPDATE ON auctions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_lots_updated_at') THEN
    CREATE TRIGGER update_lots_updated_at
    BEFORE UPDATE ON lots
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END$$;
