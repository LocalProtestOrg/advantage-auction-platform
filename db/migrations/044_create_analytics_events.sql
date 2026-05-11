-- Migration 044: analytics_events — lightweight append-only telemetry store
--
-- Design principles:
--   Append-only: no UPDATEs or DELETEs in application code.
--   JSONB metadata: flexible per-event data without schema churn.
--   No raw PII: IP addresses are hashed before storage; no email/password fields.
--   session_id: random non-identifying client token, not linked to auth.
--   Nullable contextual fields: events only carry what is relevant to that type.
--
-- Retention: recommend partitioning by month (or pg_partman) at >10M rows.
-- Indexes: tuned for the query patterns in docs/analytics-telemetry.md.

CREATE TABLE IF NOT EXISTS analytics_events (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT         NOT NULL,
  event_ver    SMALLINT     NOT NULL DEFAULT 1,

  -- Session context (non-identifying)
  session_id   TEXT,                                   -- random token, not user-linked
  device_type  TEXT CHECK (device_type IN ('desktop', 'mobile', 'tablet')),

  -- Page context
  page_url     TEXT,
  referrer     TEXT,

  -- Entity context — public IDs only, all nullable
  widget_name  TEXT,
  auction_id   UUID,
  seller_id    UUID,
  city         TEXT,
  state_code   TEXT,

  -- Flexible per-event data
  metadata     JSONB        NOT NULL DEFAULT '{}',

  -- Timing
  received_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  client_ts    TIMESTAMPTZ,

  -- Privacy: SHA-256(client_ip) truncated to 16 hex chars — rate-limit analysis only
  ip_hash      TEXT
);

-- ── Indexes ────────────────────────────────────────────────────────────────────

-- Primary time-series query: event counts over a period
CREATE INDEX IF NOT EXISTS analytics_events_type_ts
  ON analytics_events (event_type, received_at DESC);

-- Full time-range scans (dashboard, retention cleanup)
CREATE INDEX IF NOT EXISTS analytics_events_ts
  ON analytics_events (received_at DESC);

-- Session funnel queries
CREATE INDEX IF NOT EXISTS analytics_events_session
  ON analytics_events (session_id)
  WHERE session_id IS NOT NULL;

-- Auction-level engagement queries
CREATE INDEX IF NOT EXISTS analytics_events_auction
  ON analytics_events (auction_id, received_at DESC)
  WHERE auction_id IS NOT NULL;

-- Widget performance queries
CREATE INDEX IF NOT EXISTS analytics_events_widget
  ON analytics_events (widget_name, received_at DESC)
  WHERE widget_name IS NOT NULL;

-- Regional / city-level queries
CREATE INDEX IF NOT EXISTS analytics_events_city
  ON analytics_events (state_code, city)
  WHERE state_code IS NOT NULL;

-- Arbitrary metadata queries (GIN — use sparingly on large tables)
CREATE INDEX IF NOT EXISTS analytics_events_metadata_gin
  ON analytics_events USING gin (metadata);

-- ── Retention comment ──────────────────────────────────────────────────────────
-- Raw events are valuable for 90 days; aggregate into summary tables after that.
-- At scale, partition this table by month using pg_partman or range partitioning:
--   PARTITION BY RANGE (received_at)
-- This allows dropping old partitions without a DELETE scan.
