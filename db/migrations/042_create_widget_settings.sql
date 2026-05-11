-- Migration: 042_create_widget_settings.sql
-- Per-widget configuration defaults.
-- widget_slug is the canonical identifier (e.g. 'featured-lots').
-- settings JSONB stores widget.* keys that override platform defaults for
-- that widget only. Merged on top of platform_settings at read time.

CREATE TABLE IF NOT EXISTS widget_settings (
  widget_slug  TEXT PRIMARY KEY,
  settings     JSONB NOT NULL DEFAULT '{}',
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO widget_settings (widget_slug, settings, description) VALUES
  ('featured-lots',
   '{"widget.limit": 6}',
   'Featured Lots widget display defaults'),

  ('featured-near-you',
   '{"widget.limit": 6, "widget.radius_km": 200}',
   'Featured Near You widget display defaults')

ON CONFLICT (widget_slug) DO NOTHING;
