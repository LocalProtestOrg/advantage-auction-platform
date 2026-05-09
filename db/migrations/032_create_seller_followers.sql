-- Migration: 032_create_seller_followers.sql
-- Foundational table for buyer-follows-seller audience infrastructure.
-- Mirrors the watchlists pattern: unique (user, entity) pair + indexed both ways.

CREATE TABLE IF NOT EXISTS seller_followers (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id)           ON DELETE CASCADE,
  seller_id  UUID        NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, seller_id)
);

CREATE INDEX idx_seller_followers_user   ON seller_followers(user_id);
CREATE INDEX idx_seller_followers_seller ON seller_followers(seller_id);
