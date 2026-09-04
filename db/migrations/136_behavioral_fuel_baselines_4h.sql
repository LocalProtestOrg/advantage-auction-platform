-- 136_behavioral_fuel_baselines_4h.sql — Marketing Agency Phase 4H. ADDITIVE / idempotent /
-- non-destructive. Adds the PRE-autonomous-marketing baseline snapshot store. NOTHING here connects a
-- provider, sends, spends, or imports a list. Platform-fact audiences + signals reuse existing tables
-- (marketing_audience_members / marketing_signals) — no new membership store.

-- Immutable baseline snapshots: each row is one metric measured at a point in time. History is never
-- rewritten (append-only); a metric's definition + known limitations are stored alongside the value.
CREATE TABLE IF NOT EXISTS marketing_baselines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_key  TEXT NOT NULL,                 -- groups all metrics captured in one run
  metric_key    TEXT NOT NULL,
  value_numeric NUMERIC,
  value_text    TEXT,
  window_label  TEXT,                          -- e.g. 'all_time' | 'last_90d'
  definition    TEXT,
  limitations   TEXT,                          -- e.g. 'UNKNOWN — no historical linkage'
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       TEXT NOT NULL DEFAULT 'v1'
);
CREATE INDEX IF NOT EXISTS idx_marketing_baselines_snapshot ON marketing_baselines(snapshot_key, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_baselines_metric ON marketing_baselines(metric_key, captured_at DESC);

-- Config: platform-fact audience refresh cadence hints (worker self-gates on marketing.behavioral.enabled).
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.refresh.platform_fact_minutes', '15'::jsonb, 'marketing'),
  ('marketing.refresh.behavioral_minutes',    '60'::jsonb, 'marketing'),
  ('marketing.watcher_ending_soon.enabled',   'true'::jsonb, 'marketing')   -- TRANSACTIONAL watcher closing reminder (NOT marketing)
ON CONFLICT (key) DO NOTHING;
