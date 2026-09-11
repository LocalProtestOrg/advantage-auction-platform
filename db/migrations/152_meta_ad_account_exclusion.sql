-- 152_meta_ad_account_exclusion.sql — Owner-excluded Meta ad accounts (Owner directive 2026-09-11).
-- act_664514018846795 is unrelated historical advertising: it must never be used for Advantage.Bid measurement,
-- reporting, recommendations or cost ingestion. The connect step, the cost puller and cost ingestion all refuse any
-- account on this list. Additive + idempotent; no gate change.
INSERT INTO platform_config (key, value, category, description) VALUES
  ('marketing.measurement.meta_ad_account_excluded', '["act_664514018846795"]'::jsonb, 'marketing',
   'Meta ad accounts the Owner has excluded from all Advantage.Bid measurement, reporting, recommendations and cost ingestion (never connected, never pulled, never ingested).')
ON CONFLICT (key) DO NOTHING;
