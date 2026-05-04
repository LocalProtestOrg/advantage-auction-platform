-- Advantage Auction Platform — database initialization
--
-- Run once (or re-run safely — fully idempotent):
--   psql -U postgres -d advantage_auction -f scripts/init-db.sql
--
-- NOTE: The production tables (auctions, bids, lots, etc.) already exist
-- from the full schema migrations. This script creates two lightweight
-- tables used exclusively by the frontend bidding interface, plus seeds
-- the test users and test auction.
-- The shared `users` table comes from the production schema and is reused.

-- ── Frontend-facing tables ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_auctions (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT          NOT NULL,
  current_price     NUMERIC(10,2) NOT NULL DEFAULT 0,
  end_time          TIMESTAMPTZ,
  current_winner_id UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_bids (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id   UUID         NOT NULL REFERENCES app_auctions(id) ON DELETE CASCADE,
  user_id      UUID         NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  amount_cents INTEGER      NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── Test users (password: "password") ─────────────────────────────────────
-- Uses pgcrypto crypt() — produces $2a$ blowfish hashes compatible with
-- Node bcrypt.compare().
INSERT INTO users (id, email, password_hash, role) VALUES
  ('00000000-0000-4000-8000-000000000001',
   'user_1@test.com', crypt('password', gen_salt('bf', 10)), 'buyer'),
  ('00000000-0000-4000-8000-000000000002',
   'user_2@test.com', crypt('password', gen_salt('bf', 10)), 'buyer'),
  ('00000000-0000-4000-8000-000000000003',
   'user_3@test.com', crypt('password', gen_salt('bf', 10)), 'buyer')
ON CONFLICT (email) DO NOTHING;

-- ── Test auction (UUID matches TEST_AUCTION_ID in .env) ───────────────────
INSERT INTO app_auctions (id, title, current_price, end_time) VALUES
  ('565f9db4-1154-496d-bce8-f8cfb828d5f3',
   'Test Auction', 100.00, '2026-12-31 23:59:59+00')
ON CONFLICT (id) DO NOTHING;
