-- Migration: 062_extend_auction_buyers_registration.sql
-- #20 Auction (bidder) registration — reuses the existing (unused) auction_buyers
-- table (001) rather than adding a new table. Adds the columns the registration
-- gate needs and a UNIQUE(auction_id, user_id) so registration is idempotent.
--
-- Bid gate (enforced server-side in bidService/lots route) requires, per auction:
--   active user + accepted current buyer terms + an ACTIVE registration row.

ALTER TABLE auction_buyers
  ADD COLUMN IF NOT EXISTS terms_acceptance_id UUID REFERENCES terms_acceptances(id),
  ADD COLUMN IF NOT EXISTS pickup_acknowledged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- One registration row per (auction, user) → makes register idempotent (upsert).
CREATE UNIQUE INDEX IF NOT EXISTS idx_auction_buyers_unique_reg
  ON auction_buyers(auction_id, user_id);

-- Constrain status (active | revoked). ADD CONSTRAINT has no IF NOT EXISTS, so guard it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_auction_buyers_status') THEN
    ALTER TABLE auction_buyers
      ADD CONSTRAINT chk_auction_buyers_status CHECK (status IN ('active', 'revoked'));
  END IF;
END $$;
