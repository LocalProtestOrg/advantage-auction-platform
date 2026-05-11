-- Migration: 043_create_marketing_packages.sql
-- Marketing packages available to sellers for auction promotion.
-- price_cents avoids floating-point rounding. is_active allows archiving
-- without deletion so historical records remain intact.
-- features is a JSON array of human-readable capability strings.

CREATE TABLE IF NOT EXISTS marketing_packages (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  description    TEXT,
  price_cents    INTEGER     NOT NULL CHECK (price_cents >= 0),
  features       JSONB       NOT NULL DEFAULT '[]',
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  display_order  INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID        REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_marketing_packages_active
  ON marketing_packages(is_active, display_order);

-- Seed standard tier packages.
-- ON CONFLICT DO NOTHING: safe to re-run; preserves any admin edits.
INSERT INTO marketing_packages
  (name, description, price_cents, features, display_order)
VALUES
  (
    'Basic Listing',
    'Standard auction listing with platform discovery and buyer notifications.',
    0,
    '["Platform search listing","Buyer notification emails","Standard analytics"]',
    1
  ),
  (
    'Featured Placement',
    'Your auction appears in the Featured Lots and Featured Near You widgets on partner sites.',
    9900,
    '["Featured widget placement","Priority ranking boost","Platform search listing","Standard analytics"]',
    2
  ),
  (
    'Premium Marketing',
    'Full marketing campaign with email, social, and featured widget placement.',
    24900,
    '["Email campaign (10,000+ subscribers)","Social media promotion","Featured widget placement","Priority ranking boost","Detailed campaign analytics"]',
    3
  )
ON CONFLICT DO NOTHING;
