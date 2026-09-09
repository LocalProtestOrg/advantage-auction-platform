-- 146_social_intelligence.sql — Meta organic social INTELLIGENCE + Director feedback loop. ADDITIVE + idempotent.
--
-- Closes the loop PUBLISH → OBSERVE → MEASURE → INGEST → DIRECTOR ANALYSIS → DURABLE LEARNING, extending the
-- certified organic runtime (mig 144/145) — NOT a parallel analytics platform:
--   1. marketing_social_jobs gains the linkage + polling columns the loop needs (platform / destination /
--      market / creative / copy style / bounded insights-poll schedule).
--   2. marketing_social_metric_snapshots — per-post provider metrics at bounded windows (h1/h24/h72/d7/d14),
--      idempotent per (job, window). Missing/unsupported metrics are recorded HONESTLY as unavailable — never
--      fabricated. Provider IDs + timestamps retained.
--   3. marketing_social_account_snapshots — daily per-destination account facts (followers etc.).
--   4. marketing_social_engagement_events — comments/reactions/shares observed on OUR posts. Data-minimized:
--      provider ids + a text excerpt + a deterministic classification. NO commenter identity is stored
--      (no user ids, names, profile links). Autonomous public REPLIES are structurally disabled (no
--      published_reply column is ever written by runtime code).
--   5. marketing_social_webhook_events — durable, replay-protected webhook deliveries (dedup key), bounded.
--   6. Config: the PAID Meta gate is SPLIT from the ORGANIC publishing gate. `marketing.destinations.meta_enabled`
--      stays the organic-publishing provider gate (certified build). NEW `marketing.destinations.meta_ads_enabled`
--      (FALSE) governs Custom Audiences / Conversions API / Marketing API — so flipping organic publishing can
--      NEVER silently authorize paid retargeting. Insights ingestion + reply drafting have their own switches (FALSE).
--   7. Seeds the Owner-supplied NON-secret national identifiers (Facebook Page ID / Instagram Business Account
--      ID) onto the existing INACTIVE national destination rows. active stays FALSE; no token is stored.
-- NOTHING here publishes, replies, spends, or flips a publishing gate.

-- ── 1. Social job linkage + bounded insights polling ──
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS platform              TEXT;           -- facebook | instagram
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS destination_id        UUID;           -- marketing_social_destinations.id (no FK: destination rows may be re-created)
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS state_code            TEXT;           -- event geography used for routing
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS market_key            TEXT;
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS creative_job_id       TEXT;           -- marketing_creative_jobs.job_id (creative family linkage)
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS copy_style            TEXT;           -- headline family (e.g. 'Now live' / 'Closing soon')
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS insights_status       TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS next_insights_poll_at TIMESTAMPTZ;
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS insights_poll_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS insights_error_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketing_social_jobs ADD COLUMN IF NOT EXISTS last_insights_at      TIMESTAMPTZ;
ALTER TABLE marketing_social_jobs DROP CONSTRAINT IF EXISTS marketing_social_jobs_insights_status_check;
ALTER TABLE marketing_social_jobs ADD CONSTRAINT marketing_social_jobs_insights_status_check
  CHECK (insights_status IN ('not_applicable','pending','partial','complete','unavailable','error'));
CREATE INDEX IF NOT EXISTS idx_social_jobs_insights_due
  ON marketing_social_jobs (next_insights_poll_at) WHERE status = 'published' AND shadow = false AND next_insights_poll_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_social_jobs_post ON marketing_social_jobs (post_id) WHERE post_id IS NOT NULL;

-- ── 2. Per-post metric snapshots (bounded windows; idempotent; honest availability) ──
CREATE TABLE IF NOT EXISTS marketing_social_metric_snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  social_job_id     UUID NOT NULL REFERENCES marketing_social_jobs(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL CHECK (platform IN ('facebook','instagram')),
  provider_post_id  TEXT NOT NULL,
  destination_id    UUID,
  window_key        TEXT NOT NULL CHECK (window_key IN ('h1','h24','h72','d7','d14','event','manual')),
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- normalized_key -> { value: number|null, availability: 'available'|'unavailable'|'not_supported'|'error', provider_metric: text }
  metrics           JSONB NOT NULL DEFAULT '{}',
  provider_status   TEXT NOT NULL DEFAULT 'ok' CHECK (provider_status IN ('ok','partial','error')),
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (social_job_id, window_key)
);
CREATE INDEX IF NOT EXISTS idx_social_snap_job ON marketing_social_metric_snapshots (social_job_id, observed_at DESC);

-- ── 3. Daily per-destination account snapshots (followers / reach; aggregate only) ──
CREATE TABLE IF NOT EXISTS marketing_social_account_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id      UUID NOT NULL,
  platform            TEXT NOT NULL CHECK (platform IN ('facebook','instagram')),
  provider_account_id TEXT NOT NULL,
  day                 DATE NOT NULL,
  metrics             JSONB NOT NULL DEFAULT '{}',
  provider_status     TEXT NOT NULL DEFAULT 'ok' CHECK (provider_status IN ('ok','partial','error')),
  error               TEXT,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (destination_id, day)
);

-- ── 4. Engagement events on OUR posts (data-minimized; no commenter identity; replies never published by runtime) ──
CREATE TABLE IF NOT EXISTS marketing_social_engagement_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform              TEXT NOT NULL CHECK (platform IN ('facebook','instagram')),
  destination_id        UUID,
  provider_post_id      TEXT,
  social_job_id         UUID REFERENCES marketing_social_jobs(id) ON DELETE SET NULL,
  event_kind            TEXT NOT NULL CHECK (event_kind IN ('comment','reaction','share','mention','other')),
  provider_event_id     TEXT NOT NULL,                 -- comment id / synthetic reaction key — dedup
  occurred_at           TIMESTAMPTZ,
  text_excerpt          TEXT,                          -- comments only; ≤ 500 chars; no author fields
  classification        TEXT NOT NULL DEFAULT 'unclassified'
                          CHECK (classification IN ('question','purchase_intent','positive','negative','complaint','spam','other','unclassified')),
  classification_reason TEXT,
  source                TEXT NOT NULL DEFAULT 'poll' CHECK (source IN ('poll','webhook','manual')),
  response_state        TEXT NOT NULL DEFAULT 'observed'
                          CHECK (response_state IN ('observed','no_response_needed','draft_pending','draft_ready')),
  draft_text            TEXT,                          -- governed DRAFT only; publishing is structurally disabled
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_social_engagement_post ON marketing_social_engagement_events (provider_post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_engagement_class ON marketing_social_engagement_events (classification, created_at DESC);

-- ── 5. Webhook deliveries (replay-protected; bounded; payload only for OUR registered accounts) ──
CREATE TABLE IF NOT EXISTS marketing_social_webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key     TEXT NOT NULL UNIQUE,                  -- sha256(object|entry_id|time|field|value)
  object        TEXT,                                  -- page | instagram
  entry_id      TEXT,                                  -- provider account id the change belongs to
  field         TEXT,
  change        JSONB,                                 -- stored ONLY when entry_id is a registered destination; NULL otherwise
  status        TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','error')),
  error         TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_social_webhook_status ON marketing_social_webhook_events (status, received_at DESC);

-- ── 6. Config: split PAID Meta from ORGANIC Meta; ingestion + drafting switches (all FALSE) ──
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.destinations.meta_ads_enabled', 'false'::jsonb, 'marketing'),   -- PAID: Custom Audiences / CAPI / Marketing API — OFF
  ('marketing.social.insights_enabled',       'false'::jsonb, 'marketing'),   -- read-only insights ingestion — OFF until Owner activates
  ('marketing.social.reply_draft_enabled',    'false'::jsonb, 'marketing')    -- governed reply DRAFTING — OFF (publishing has no switch: structurally disabled)
ON CONFLICT (key) DO NOTHING;

-- ── 7. Owner-supplied NON-secret national identifiers (active stays FALSE; no token stored) ──
UPDATE marketing_social_destinations
   SET provider_account_id = '449143945236360', label = 'National Facebook (AdvantageBid)', updated_at = now()
 WHERE platform = 'facebook' AND scope = 'national' AND provider_account_id IS NULL;
UPDATE marketing_social_destinations
   SET provider_account_id = '17841436199617514', linked_facebook_page_id = '449143945236360',
       label = 'National Instagram (@advantagebid)', updated_at = now()
 WHERE platform = 'instagram' AND scope = 'national' AND provider_account_id IS NULL;
