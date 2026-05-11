-- Migration: 041_create_platform_settings.sql
-- Marketplace configuration key/value store.
-- Every marketplace-facing business variable lives here so admin can edit
-- without a code deploy. Values are JSONB to support strings, numbers, booleans,
-- and null. All keys are pre-seeded with safe platform defaults.
--
-- Do NOT store Stripe keys, payment credentials, or bidding logic here.
-- This table is designed for marketplace presentation variables only.

CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Seed safe defaults for all marketplace-facing configuration keys.
-- INSERT ... ON CONFLICT DO NOTHING preserves any values already set.
INSERT INTO platform_settings (key, value, description) VALUES
  ('marketplace.badge.live',
   '"LIVE NOW"',
   'Status badge label for active auctions'),

  ('marketplace.badge.upcoming',
   '"UPCOMING"',
   'Status badge label for published auctions'),

  ('marketplace.badge.ships',
   '"Ships nationwide"',
   'Shipping availability badge label'),

  ('marketplace.badge.ending_soon',
   '"Ending Soon"',
   'Urgency badge label for lots closing soon'),

  ('marketplace.badge.ending_soon_threshold_min',
   '120',
   'Minutes remaining to trigger ending-soon badge'),

  ('marketplace.cta.headline',
   '"Consigning an Estate?"',
   'Seller CTA card headline'),

  ('marketplace.cta.subtext',
   '"We auction estates, collections, and commercial inventory nationwide."',
   'Seller CTA supporting text'),

  ('marketplace.cta.label',
   '"Learn More"',
   'Seller CTA button label'),

  ('marketplace.cta.url',
   'null',
   'Seller CTA destination URL — null hides the CTA card'),

  ('marketplace.card.image_height_px',
   '168',
   'Card image area height in pixels'),

  ('marketplace.card.show_seller',
   'true',
   'Show seller display name on cards'),

  ('marketplace.card.show_lot_count',
   'true',
   'Show lot count on auction cards'),

  ('marketplace.card.show_bid',
   'true',
   'Show current/starting bid on lot cards'),

  ('marketplace.shipping.show_badge',
   'true',
   'Show shipping badge when lot is shippable'),

  ('marketplace.homepage.featured_limit',
   '6',
   'Maximum featured lots shown in homepage widgets'),

  ('marketplace.homepage.near_you_limit',
   '6',
   'Maximum near-you auctions shown in homepage widgets'),

  ('marketplace.ranking.priority_weight',
   '1.0',
   'Weight applied to marketplace_priority in feed ranking'),

  ('marketplace.ranking.recency_weight',
   '0.3',
   'Weight applied to recency in feed ranking')

ON CONFLICT (key) DO NOTHING;
