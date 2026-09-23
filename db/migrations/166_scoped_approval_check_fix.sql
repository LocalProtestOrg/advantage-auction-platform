-- 166_scoped_approval_check_fix.sql — ADDITIVE + idempotent.
--
-- Migration 165's chk_mcp_scope_shape could be satisfied by a malformed scope: for a scope without
-- "campaign_keys", jsonb_typeof(...) is NULL, the comparison is NULL, and a CHECK treats NULL as
-- passing. Caught by prod-migrate-165 verification before any package carried a scope. This replaces
-- the constraint with a NULL-safe one: a scope must name at least one campaign AND a numeric maximum.

BEGIN;

ALTER TABLE marketing_creative_packages DROP CONSTRAINT IF EXISTS chk_mcp_scope_shape;
ALTER TABLE marketing_creative_packages ADD CONSTRAINT chk_mcp_scope_shape CHECK (
  approval_scope IS NULL OR (
    COALESCE(jsonb_typeof(approval_scope -> 'campaign_keys') = 'array', false)
    AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(approval_scope -> 'campaign_keys') = 'array'
                                          THEN approval_scope -> 'campaign_keys' ELSE '[]'::jsonb END) > 0, false)
    AND COALESCE(jsonb_typeof(approval_scope -> 'max_authorization_cents') = 'number', false)));

COMMIT;
