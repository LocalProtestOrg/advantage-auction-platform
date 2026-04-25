-- Migration: 022_create_watchlists.sql
-- Allows users to follow lots without placing a bid.

CREATE TABLE IF NOT EXISTS watchlists (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lot_id     UUID        NOT NULL REFERENCES lots(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lot_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);
CREATE INDEX IF NOT EXISTS idx_watchlists_lot  ON watchlists(lot_id);
