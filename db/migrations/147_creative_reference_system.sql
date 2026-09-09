-- 147_creative_reference_system.sql — Phase 3P Owner Creative Reference System. ADDITIVE + idempotent.
--
-- Durable creative CALIBRATION infrastructure around the Phase 3O/3M.3 creative runtime (nothing in the compositor,
-- extraction gate, brand frame, claim manifest, obligation model or publish gates is remodelled):
--   1. marketing_creative_references        — the indexed Owner reference library (identity = image sha256; the
--                                             Owner's folder is the source of truth; the indexer reconciles by hash so
--                                             renames/moves lose nothing; sidecar JSON stored for retrieval).
--   2. marketing_creative_reference_decisions — mirror of the append-only Owner decisions ledger (owner-decisions.jsonl).
--   3. marketing_creative_calibrations      — one row per generated candidate: retrieved references, principle profile,
--                                             do-not-copy list, metrics, judge, hard checks, similarity, score, decision,
--                                             publication status (HELD_FOR_OWNER_REVIEW by default).
--   4. marketing_creative_layout_signatures — perceptual layout signatures for references and candidates (anti-copy).
--   5. marketing_creative_owner_reviews     — Owner review rows for generated creatives (the G14 hold is released only
--                                             by an Owner review with status approved/gold).
-- Reference images are NEVER stored in the database — only their hashes and sidecar metadata.

CREATE TABLE IF NOT EXISTS marketing_creative_references (
  sha256                   TEXT PRIMARY KEY,
  reference_id             TEXT NOT NULL,
  current_path             TEXT,
  owner_status             TEXT NOT NULL CHECK (owner_status IN ('OWNER_APPROVED','OWNER_GOLD_STANDARD','OWNER_DO_NOT_USE','RETIRED')),
  owner_weight             NUMERIC NOT NULL DEFAULT 1.0,
  campaign_class_primary   TEXT,
  campaign_class_secondary JSONB NOT NULL DEFAULT '[]',
  owner_folder             TEXT,
  visual_family            TEXT,
  nearest_advantage_family TEXT,
  seller                   TEXT,
  stub                     BOOLEAN NOT NULL DEFAULT false,   -- image indexed without a Desktop Marketing visual read yet
  sidecar                  JSONB NOT NULL DEFAULT '{}',
  sidecar_hash             TEXT,
  index_version            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creative_refs_class ON marketing_creative_references (campaign_class_primary, owner_status);

CREATE TABLE IF NOT EXISTS marketing_creative_reference_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_hash   TEXT NOT NULL UNIQUE,               -- sha256 of the ledger line (idempotent application)
  ts            TIMESTAMPTZ,
  source        TEXT NOT NULL,
  owner_words   TEXT,
  resolved      JSONB NOT NULL DEFAULT '{}',
  action        TEXT NOT NULL,
  status        TEXT,
  payload       JSONB NOT NULL DEFAULT '{}',
  recorded_by   TEXT,
  applied_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_creative_calibrations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_job_id        TEXT NOT NULL,
  candidate_key          TEXT NOT NULL,              -- e.g. 'A', 'B', 'C'
  campaign_class         TEXT NOT NULL,
  family                 TEXT NOT NULL,
  format                 TEXT,
  seller                 TEXT,
  index_version          TEXT,
  retrieved              JSONB NOT NULL DEFAULT '[]', -- [{reference_id, weight, sidecar_hash}]
  principle_profile      JSONB NOT NULL DEFAULT '{}',
  do_not_copy            JSONB NOT NULL DEFAULT '{}',
  brief                  JSONB NOT NULL DEFAULT '{}',
  metrics                JSONB NOT NULL DEFAULT '{}',
  judge                  JSONB,                      -- two runs + average, or {available:false, reason}
  hard_checks            JSONB NOT NULL DEFAULT '{}',
  similarity             JSONB NOT NULL DEFAULT '{}',
  score                  NUMERIC,
  score_breakdown        JSONB NOT NULL DEFAULT '{}',
  decision               TEXT NOT NULL,              -- ACCEPT | REGENERATE | FALLBACK_DEFAULT_FAMILY | BLOCKED_CALIBRATION | OWNER_REVIEW | HARD_FAIL
  owner_review_required  BOOLEAN NOT NULL DEFAULT true,
  publication_status     TEXT NOT NULL DEFAULT 'HELD_FOR_OWNER_REVIEW'
                           CHECK (publication_status IN ('HELD_FOR_OWNER_REVIEW','NOT_FOR_PUBLICATION','OWNER_APPROVED','OWNER_REJECTED')),
  render_path            TEXT,
  render_sha256          TEXT,
  scorer_version         TEXT,
  judge_model            TEXT,
  prompt_version         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (creative_job_id, candidate_key, format)
);
CREATE INDEX IF NOT EXISTS idx_creative_cal_job ON marketing_creative_calibrations (creative_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_cal_family_seller ON marketing_creative_calibrations (family, seller, created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_creative_layout_signatures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('reference','creative','anchor')),
  subject_id    TEXT NOT NULL,                       -- reference sha256 | creative_job_id:candidate:format | anchor sha256
  family        TEXT,
  seller        TEXT,
  campaign_class TEXT,
  signature     JSONB NOT NULL,
  signature_version TEXT NOT NULL DEFAULT 'sig-v1',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_id)
);

CREATE TABLE IF NOT EXISTS marketing_creative_owner_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_job_id TEXT NOT NULL,
  candidate_key   TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','approved','gold','rejected','note')),
  owner_words     TEXT,
  note            JSONB,
  source          TEXT NOT NULL DEFAULT 'owner_review_of_generated_creative',
  recorded_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creative_reviews_job ON marketing_creative_owner_reviews (creative_job_id, created_at DESC);

-- Calibration constants live in config (not code): weights, relevance factors, bars, similarity thresholds.
INSERT INTO platform_config (key, value, category) VALUES
  ('marketing.creative.ref_weight.owner_approved',      '1.0'::jsonb,  'marketing'),
  ('marketing.creative.ref_weight.owner_gold_standard', '2.0'::jsonb,  'marketing'),
  ('marketing.creative.ref_weight.owner_do_not_use',    '-1.0'::jsonb, 'marketing'),
  ('marketing.creative.ref_weight.retired',             '0'::jsonb,    'marketing'),
  ('marketing.creative.calibration.accept_bar',         '70'::jsonb,   'marketing'),
  ('marketing.creative.calibration.accept_bar_gold',    '75'::jsonb,   'marketing'),
  ('marketing.creative.calibration.regenerate_floor',   '50'::jsonb,   'marketing'),
  ('marketing.creative.similarity.tau_ref',             '0.35'::jsonb, 'marketing'),
  ('marketing.creative.similarity.tau_self',            '0.25'::jsonb, 'marketing'),
  ('marketing.creative.similarity.tau_pub',             '0.40'::jsonb, 'marketing'),
  ('marketing.creative.scatter_ration_per_quarter',     '5'::jsonb,    'marketing')   -- CATALOG_SCATTER at most 1 in N per seller per quarter
ON CONFLICT (key) DO NOTHING;
