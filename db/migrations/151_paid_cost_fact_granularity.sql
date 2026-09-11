-- 151_paid_cost_fact_granularity.sql — the Director's paid measurement grain: ad set / ad / creative names and ids,
-- reach and link clicks, plus the provider's own reported ratios (CTR, CPC, CPM) and unmapped action counts.
-- Additive + idempotent; nullable columns; no data change; no gate change.
ALTER TABLE marketing_paid_cost_facts ADD COLUMN IF NOT EXISTS adset_name TEXT;
ALTER TABLE marketing_paid_cost_facts ADD COLUMN IF NOT EXISTS ad_name TEXT;
ALTER TABLE marketing_paid_cost_facts ADD COLUMN IF NOT EXISTS creative_id TEXT;
ALTER TABLE marketing_paid_cost_facts ADD COLUMN IF NOT EXISTS reach BIGINT;                -- daily reach as reported (not additive across days)
ALTER TABLE marketing_paid_cost_facts ADD COLUMN IF NOT EXISTS link_clicks BIGINT;          -- inline_link_clicks
ALTER TABLE marketing_paid_cost_facts ADD COLUMN IF NOT EXISTS provider_metrics JSONB NOT NULL DEFAULT '{}';  -- {ctr, cpc, cpm, actions:{action_type:n}} as reported
