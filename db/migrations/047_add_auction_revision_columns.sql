-- GOV-RET: columns supporting the Return-to-Draft moderation workflow.
--
-- revision_note holds the operator's reason text shown back to the seller on
-- the dashboard banner. It is cleared (not retained) on the next submission
-- so each revision cycle has its own dedicated message — see the admin
-- endpoint which only writes the column on the return-to-draft transition.
--
-- revision_count is monotonically incremented every time the auction is
-- returned to draft. Surfaces in the seller-visible audit (AUD-EXP) and is
-- used by the seller dashboard to decide whether to show the "Revision
-- requested" banner alongside the existing draft state — count > 0 means
-- this draft is a re-submission cycle, not a fresh creation.
--
-- IF NOT EXISTS keeps the migration idempotent so a partial re-run after
-- failure does not error on the second pass.

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS revision_note  TEXT;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS revision_count INTEGER NOT NULL DEFAULT 0;
