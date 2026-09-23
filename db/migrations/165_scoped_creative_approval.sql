-- 165_scoped_creative_approval.sql — ADDITIVE + idempotent.
--
-- The Owner can approve a creative package for ONE narrowly defined use — e.g. "a controlled $25
-- text-only test" — without that approval becoming general permission for larger campaigns. Until
-- now approval was all-or-nothing (approval_state = OWNER_APPROVED).
--
--   approval_scope      NULL = unrestricted Owner approval (every existing package keeps this).
--                       Otherwise {"campaign_keys":[...], "max_authorization_cents": N, "purpose": "..."}:
--                       metaDeliveryService.buildExperimentHierarchy refuses the package for any other
--                       campaign, or for a campaign authorized above the maximum.
--   approval_recorded_at / approval_evidence   when and on what Owner decision the approval rests.
--
-- No existing package, campaign, ledger row or provider object changes.

BEGIN;

ALTER TABLE marketing_creative_packages ADD COLUMN IF NOT EXISTS approval_scope jsonb;
ALTER TABLE marketing_creative_packages ADD COLUMN IF NOT EXISTS approval_recorded_at timestamptz;
ALTER TABLE marketing_creative_packages ADD COLUMN IF NOT EXISTS approval_evidence text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_mcp_scope_shape') THEN
    ALTER TABLE marketing_creative_packages ADD CONSTRAINT chk_mcp_scope_shape CHECK (
      approval_scope IS NULL OR (
        jsonb_typeof(approval_scope -> 'campaign_keys') = 'array'
        AND jsonb_array_length(approval_scope -> 'campaign_keys') > 0
        AND jsonb_typeof(approval_scope -> 'max_authorization_cents') = 'number'));
  END IF;
END $$;

COMMIT;
