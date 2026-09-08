-- 143_marketing_creative_jobs.sql — Phase 3O Wave 1: durable creative jobs + provenance for the autonomous
-- creative production engine. ADDITIVE + idempotent. NOTHING sends/publishes/spends/flips a gate.

CREATE TABLE IF NOT EXISTS marketing_creative_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          TEXT NOT NULL,
  auction_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','review','engine_unavailable','failed')),
  request         JSONB NOT NULL DEFAULT '{}',
  result          JSONB,               -- audit + qa + selection + creative + provenance (no PII)
  runtime_version TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_job_id ON marketing_creative_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_creative_job_auction ON marketing_creative_jobs(auction_id, created_at DESC);

-- Durable creative provenance: auction -> lot -> source image -> extraction -> fidelity -> creative usage.
CREATE TABLE IF NOT EXISTS marketing_creative_provenance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          TEXT NOT NULL,
  auction_id      TEXT,
  lot_id          TEXT NOT NULL,
  source_image    TEXT,
  fidelity        TEXT,                -- CLEAN | REVIEW | FAILED
  extracted_asset TEXT,
  rgb_edited      BOOLEAN NOT NULL DEFAULT false,   -- MUST stay false (alpha-only; no RGB edit)
  generative      BOOLEAN NOT NULL DEFAULT false,   -- MUST stay false (no generative reconstruction)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creative_provenance_job ON marketing_creative_provenance(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_provenance ON marketing_creative_provenance(job_id, lot_id);
