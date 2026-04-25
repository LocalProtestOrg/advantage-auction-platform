-- Migration: 014_create_marketing_jobs.sql
-- Stores marketing package selections made by sellers for their auctions.
-- Inserted automatically when a seller selects a marketing package.

CREATE TABLE IF NOT EXISTS marketing_jobs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id          UUID        NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  seller_user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_type        TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'pending',
  budget              INTEGER,
  target_radius_miles INTEGER     NOT NULL DEFAULT 30,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_marketing_jobs_auction_id ON marketing_jobs(auction_id);
CREATE INDEX idx_marketing_jobs_seller_user_id ON marketing_jobs(seller_user_id);
