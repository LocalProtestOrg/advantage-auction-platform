-- 132_subscriber_geo_network_4d.sql — Marketing Agency Phase 4D: first-party subscriber growth +
-- geographic audience network. ADDITIVE / idempotent / non-destructive. Nothing here sends email,
-- imports lists, or activates A7/SMS. Extends the certified Phase 4C contact model (no second store):
-- geography on marketing_contacts (reusing the Mapbox geocoding seam), finer signup attribution on
-- marketing_contact_sources, an append-only permission-event audit trail, and email-radius/subscribe config.

-- ── 1. Geography on the existing marketing_contacts (city/address_state/zip already exist) ──
-- Inferred coordinates are AUDITABLE and DISTINGUISHABLE from user-supplied text. Coordinates derived
-- from a city or ZIP are centroids — never presented to a recipient as exact household distance.
ALTER TABLE marketing_contacts ADD COLUMN IF NOT EXISTS latitude            DOUBLE PRECISION;
ALTER TABLE marketing_contacts ADD COLUMN IF NOT EXISTS longitude           DOUBLE PRECISION;
ALTER TABLE marketing_contacts ADD COLUMN IF NOT EXISTS geography_precision TEXT NOT NULL DEFAULT 'unknown'
  CHECK (geography_precision IN ('postal','city_centroid','state_centroid','user_supplied_coordinates','unknown'));
ALTER TABLE marketing_contacts ADD COLUMN IF NOT EXISTS geography_source    TEXT;   -- geocoder | user_supplied | event_market | unknown
ALTER TABLE marketing_contacts ADD COLUMN IF NOT EXISTS geo_resolved_at     TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_marketing_contacts_geo   ON marketing_contacts(latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_contacts_state ON marketing_contacts(upper(address_state)) WHERE address_state IS NOT NULL;

-- ── 2. Finer signup attribution on marketing_contact_sources (source_type stays coarse) ──
-- signup_placement = footer | all_events | auctions_listing | estate_sales_listing | auction_detail |
--   estate_sale_detail | marketplace | professional_directory | blog | help_center | seller_page | other
ALTER TABLE marketing_contact_sources ADD COLUMN IF NOT EXISTS signup_placement TEXT;
ALTER TABLE marketing_contact_sources ADD COLUMN IF NOT EXISTS referrer         TEXT;   -- referring page/path (no PII)
ALTER TABLE marketing_contact_sources ADD COLUMN IF NOT EXISTS source_domain    TEXT;   -- e.g. bid.advantage.bid | advantage.bid (BD)

-- ── 3. Append-only permission audit trail (preserve consent/withdrawal evidence over time) ──
-- The CURRENT permission state lives on marketing_contacts (single source for eligibility). This table is
-- the immutable HISTORY so a re-subscribe or unsubscribe never erases the prior evidence.
CREATE TABLE IF NOT EXISTS marketing_contact_permission_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   UUID NOT NULL REFERENCES marketing_contacts(id) ON DELETE CASCADE,
  action       TEXT NOT NULL CHECK (action IN ('granted','reconfirmed','withdrawn','grant_blocked_suppressed')),
  basis        TEXT,                          -- permission_basis at the time (evidence, not a promotion trigger)
  scope        JSONB,
  source_type  TEXT,
  signup_placement TEXT,
  evidence     TEXT,                          -- affirmative-action evidence (e.g. 'explicit footer checkbox 2026-09-04')
  page_path    TEXT,
  referrer     TEXT,
  ip_hash      TEXT,                          -- hashed, never raw IP
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mc_permission_events_contact ON marketing_contact_permission_events(contact_id, created_at DESC);

-- ── 4. Config: email radius (SEPARATE from paid 30-mile) + subscribe controls ──
-- Email radius is its own policy; the paid event-local advertising radius (30mi default) is unchanged.
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.email.radius_default_miles', '50'::jsonb, 'marketing'),
  ('marketing.email.radius_allowed',       '[10,25,30,50,100]'::jsonb, 'marketing'),
  ('marketing.subscribe.enabled',          'true'::jsonb, 'marketing'),   -- public first-party signup ON (collection only; no send)
  ('marketing.subscribe.double_optin_enabled', 'false'::jsonb, 'marketing') -- immediate documented opt-in (audit §17); confirmation off
ON CONFLICT (key) DO NOTHING;
