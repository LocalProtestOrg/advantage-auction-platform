-- AI CATALOG ASSISTANT — Phase 2A.2: lot_ai_verifications (provenance store).
--
-- Stores the full provenance bundle for the button-driven Seller Verification
-- Layer so that, for any lot, we can later show and dispute-resolve:
--   - the ORIGINAL AI output (event_type='generate'),
--   - the verification schema shown to the seller,
--   - the seller's button selections,
--   - the REFINED AI output (event_type='refine'),
--   - the FINAL accepted description (event_type='final').
--
-- HARD REQUIREMENT: the system must NEVER lose the original AI output.
-- This table is APPEND-ONLY by design and by convention:
--   * one row per event ('generate' / 'refine' / 'final'),
--   * rows are never UPDATEd or DELETEd by the application (mirrors the
--     audit_log philosophy used elsewhere in this codebase),
--   * the original 'generate' row is independent of any later 'refine'/'final'
--     rows, so refinement can never overwrite or erase the original.
-- The "current" view for admin = the most recent row for a lot_id.
--
-- Additive and isolated: the lots table is NOT modified (provenance is
-- write-rarely / read-rarely; keeping it out of the hot lots row is deliberate).
--
-- Phase 2A.2 scope: storage only. No route, no AI refine endpoint, no UI, and
-- no audit integration are wired in this phase (those are post-checkpoint).
--
-- Rollback (manual — this repo uses forward-only migrations, no .down.sql):
--   DROP TABLE IF EXISTS lot_ai_verifications;

CREATE TABLE IF NOT EXISTS lot_ai_verifications (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Linkage. lot_id is nullable because AI generation runs while the seller is
  -- composing the lot, before the lot row exists; the bundle is linked to the
  -- lot when it is saved (persist-at-save via draft_correlation). ON DELETE
  -- CASCADE keeps provenance tied to the lot's lifecycle.
  lot_id               UUID REFERENCES lots(id) ON DELETE CASCADE,
  draft_correlation    TEXT,                       -- client-generated id linking pre-save events to the eventual lot
  seller_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,

  -- What was analyzed + provenance stamps (server-authoritative).
  image_url            TEXT NOT NULL,
  ai_model             TEXT NOT NULL,              -- e.g. 'claude-haiku-4-5-20251001'
  prompt_version       TEXT NOT NULL,              -- bump when prompt/registry changes (learning segmentation)

  event_type           TEXT NOT NULL CHECK (event_type IN ('generate','refine','final')),

  -- AI output for THIS event (v1 on 'generate', v2 on 'refine').
  ai_title             TEXT,
  ai_description       TEXT,
  ai_category          TEXT,

  -- The groups/options presented and the seller's button selections.
  clarification_schema JSONB,
  seller_selections    JSONB,

  -- Set on the 'final' event: exactly what was saved to the lot.
  final_description    TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin "latest for this lot" lookup + per-lot history (newest first).
CREATE INDEX IF NOT EXISTS idx_lot_ai_verifications_lot
  ON lot_ai_verifications (lot_id, created_at DESC);

-- Link pre-save events to the lot at save time.
CREATE INDEX IF NOT EXISTS idx_lot_ai_verifications_draft
  ON lot_ai_verifications (draft_correlation)
  WHERE draft_correlation IS NOT NULL;

-- Learning/export segmentation by model + prompt version.
CREATE INDEX IF NOT EXISTS idx_lot_ai_verifications_model
  ON lot_ai_verifications (ai_model, prompt_version);
