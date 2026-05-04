-- Advantage Auction Platform — production schema
-- Run once against a fresh Neon / Supabase / cloud Postgres database:
--   psql "$DATABASE_URL" -f scripts/schema.sql
--
-- Requires: pgcrypto (available on Neon and Supabase by default)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Core identity ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT         UNIQUE NOT NULL,
  password_hash TEXT         NOT NULL,
  role          TEXT         NOT NULL DEFAULT 'buyer'
                               CHECK (role IN ('admin', 'seller', 'buyer')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── Frontend bidding tables ───────────────────────────────────────────────────
-- These two tables back the simple REST + WebSocket API used by the frontend.
-- They sit alongside (and do not replace) the full production auction schema.

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
