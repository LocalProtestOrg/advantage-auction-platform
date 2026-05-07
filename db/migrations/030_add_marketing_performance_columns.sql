-- Migration: 030_add_marketing_performance_columns.sql
-- Extends marketing_jobs with performance/reporting columns for seller marketing reporting.
-- The core marketing_jobs table was created in migration 014.

ALTER TABLE marketing_jobs
  ADD COLUMN IF NOT EXISTS views_count         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicks_count        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reach_count         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watchlist_adds      INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bidder_conversions  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS top_lot_count       INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS campaign_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS campaign_ended_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT now();

-- TODO: Facebook Ads integration — pull views/clicks/reach from Facebook Campaign Insights API
-- TODO: AI-generated ad creatives — generate copy/images per lot and store creative_snapshot JSON
-- TODO: Automated geographic targeting — derive radius from auction location + package tier
-- TODO: Seller dashboard widgets — surface these columns in the seller marketing report UI
