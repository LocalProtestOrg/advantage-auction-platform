-- 144_marketing_channel_execution.sql — Phase 3O Wave 2 channel execution + evidence. ADDITIVE + idempotent.
-- Owned-placement, shared/dedicated email, social, and performance evidence. Everything runs in SHADOW
-- behind the existing gates (A7/social/paid OFF) — shadow evidence is DISTINCT and never fulfils a real
-- seller obligation. NOTHING sends/publishes/spends/flips a gate. Reuses email_suppressions + ses_feedback_events.

-- ── Owned placement inventory calendar / reservations (capacity-limited surfaces; automated collision) ──
CREATE TABLE IF NOT EXISTS marketing_placement_reservations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id  UUID REFERENCES marketing_obligations(id) ON DELETE SET NULL,
  feature_key    TEXT NOT NULL,
  auction_id     TEXT,
  lot_ids        JSONB NOT NULL DEFAULT '[]',
  slot_index     INTEGER NOT NULL DEFAULT 0,       -- which capacity slot on the surface
  start_at       TIMESTAMPTZ,
  end_at         TIMESTAMPTZ,
  days           INTEGER,
  status         TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','active','ended','released')),
  activated_at   TIMESTAMPTZ,
  shadow         BOOLEAN NOT NULL DEFAULT false,   -- owned surfaces are ACTIVE; reservations are real
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_place_res_cal ON marketing_placement_reservations(feature_key, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_place_res_ob ON marketing_placement_reservations(obligation_id);

-- ── Owned placement evidence (COMPLETED requires qualifying evidence — a reservation alone never does) ──
CREATE TABLE IF NOT EXISTS marketing_placement_evidence (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id  UUID REFERENCES marketing_obligations(id) ON DELETE SET NULL,
  feature_key    TEXT,
  auction_id     TEXT,
  lot_ids        JSONB NOT NULL DEFAULT '[]',
  reservation_id TEXT,
  first_seen_at  TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ,
  days           INTEGER,
  impressions    INTEGER NOT NULL DEFAULT 0,
  clicks         INTEGER NOT NULL DEFAULT 0,
  shadow         BOOLEAN NOT NULL DEFAULT true,   -- true = certification evidence, NOT real fulfilment
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_placement_ev_ob ON marketing_placement_evidence(obligation_id);

-- ── Shared-email editions (Premium) + per-auction cards (equal size; inclusion evidence) ──
CREATE TABLE IF NOT EXISTS marketing_email_editions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id     TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('shared','dedicated')),
  market         TEXT,
  scope          TEXT,
  week_key       TEXT,                              -- market+ISO-week for the ≤2/market/week cap
  status         TEXT NOT NULL DEFAULT 'assembling' CHECK (status IN ('assembling','assembled','queued_shadow','sent_shadow','reconciled')),
  target_cards   INTEGER NOT NULL DEFAULT 4,
  max_cards      INTEGER NOT NULL DEFAULT 6,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  sent_at        TIMESTAMPTZ,
  shadow         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_edition ON marketing_email_editions(edition_id);
CREATE INDEX IF NOT EXISTS idx_email_edition_week ON marketing_email_editions(market, week_key);

CREATE TABLE IF NOT EXISTS marketing_email_edition_cards (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id     TEXT NOT NULL,
  obligation_id  UUID REFERENCES marketing_obligations(id) ON DELETE SET NULL,
  auction_id     TEXT NOT NULL,
  position       INTEGER NOT NULL,
  delivered      INTEGER NOT NULL DEFAULT 0,
  clicks         INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_edition_card ON marketing_email_edition_cards(edition_id, auction_id);

-- ── Signature dedicated sends (scope ladder + floor-after-exclusions evidence) ──
CREATE TABLE IF NOT EXISTS marketing_dedicated_sends (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id    UUID REFERENCES marketing_obligations(id) ON DELETE SET NULL,
  auction_id       TEXT,
  chosen_scope     TEXT,                            -- LOCAL | REGIONAL | CATEGORY_SHIPPABLE | NATIONWIDE | NONE
  scopes_evaluated JSONB NOT NULL DEFAULT '[]',     -- [{scope, eligible_after_exclusions}]
  recipient_count  INTEGER NOT NULL DEFAULT 0,      -- AFTER exclusions
  audience_floor   INTEGER NOT NULL DEFAULT 300,
  sent_at          TIMESTAMPTZ,
  opens            INTEGER,
  clicks           INTEGER,
  status           TEXT NOT NULL DEFAULT 'evaluating' CHECK (status IN ('evaluating','queued_shadow','sent_shadow','no_scope','reconciled')),
  shadow           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dedicated_ob ON marketing_dedicated_sends(obligation_id);

-- ── Social jobs (provider-neutral adapter; proof) ──
CREATE TABLE IF NOT EXISTS marketing_social_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id  UUID REFERENCES marketing_obligations(id) ON DELETE SET NULL,
  auction_id     TEXT,
  wave           TEXT,                              -- LAUNCH | MID | FINAL | ANY
  provider       TEXT,                              -- mock | facebook | instagram
  status         TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','queued_shadow','published_shadow','blocked','failed')),
  post_id        TEXT,
  permalink      TEXT,
  published_at   TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0,
  proof          JSONB NOT NULL DEFAULT '{}',
  shadow         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_ob ON marketing_social_jobs(obligation_id);

-- ── Performance facts (feeds the seller ALLOWLIST renderer; classification is explicit) ──
CREATE TABLE IF NOT EXISTS marketing_performance_facts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_kind  TEXT,
  purchase_id    UUID,
  obligation_id  UUID REFERENCES marketing_obligations(id) ON DELETE SET NULL,
  metric         TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('DELIVERED','MEASURED','INFLUENCED','ATTRIBUTION_UNAVAILABLE')),
  value_numeric  NUMERIC,
  source         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_perf_purchase ON marketing_performance_facts(purchase_id);
