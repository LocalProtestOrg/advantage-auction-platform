-- 150_meta_measurement_connection.sql — Meta measurement connection (Pixel, Conversions API, cost ingestion).
-- Additive + idempotent. Adds the shared browser/server event id to the conversion ledger and the config keys the
-- connection needs. Every key is seeded OFF / null: nothing is connected, enabled or sent by this migration.
-- Paid advertising gates (marketing.destinations.*) are not touched.

-- Browser/server deduplication: the event id the browser pixel used (eventID) for the same conversion. When present the
-- Conversions API sends it as event_id so Meta counts the conversion once. NULL = server-only conversion.
ALTER TABLE marketing_conversion_events ADD COLUMN IF NOT EXISTS provider_event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conv_provider_event_id ON marketing_conversion_events(provider_event_id) WHERE provider_event_id IS NOT NULL;

INSERT INTO platform_config (key, value, category, description) VALUES
  ('marketing.measurement.meta_dataset_identity', 'null'::jsonb, 'marketing', 'Graph-verified identity of the Advantage.Bid Meta dataset (id, name, owner_business, verified_at). Written by scripts/meta-measurement-connect.js; never a client asset.'),
  ('marketing.measurement.meta_ad_account_id', 'null'::jsonb, 'marketing', 'Advantage.Bid Meta ad account id (act_…) for cost ingestion — read-only use. Never a client ad account.'),
  ('marketing.measurement.meta_ad_account_identity', 'null'::jsonb, 'marketing', 'Graph-verified identity of the Advantage.Bid ad account (id, name, owner_business, verified_at).'),
  ('marketing.measurement.meta_cost_ingestion_enabled', 'false'::jsonb, 'marketing', 'Daily READ-ONLY pull of Meta Ads spend/impressions/clicks into marketing_paid_cost_facts. Reading only — never creates, edits or spends.'),
  ('marketing.measurement.meta_verification', '{}'::jsonb, 'marketing', 'Evidence of the last Meta measurement verification (pixel, conversions API, cost pull). Written by the verify script.')
ON CONFLICT (key) DO NOTHING;
