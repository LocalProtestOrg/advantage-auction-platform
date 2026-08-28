-- 120: Authoritative reserve-not-met auction outcome.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Adds a single boolean that distinguishes a lot that closed
-- UNSOLD because its reserve was not met from a lot that closed with no bids. The money paths need
-- nothing beyond the null winner (they all filter on winning_buyer_user_id IS NOT NULL); this flag is
-- for reporting, the seller/marketplace "Reserve Not Met" experience, and Marketplace relist labeling.
-- The reserve AMOUNT (lots.reserve_cents) remains server-side/admin-only and is never exposed publicly.

ALTER TABLE lots ADD COLUMN IF NOT EXISTS reserve_not_met BOOLEAN NOT NULL DEFAULT FALSE;
