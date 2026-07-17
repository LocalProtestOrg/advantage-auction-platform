-- 092: Directory sync freshness + reconciliation status for the BD mirror.
-- ADDITIVE / NON-BREAKING. Idempotent.
--
-- Supports a true one-way BD -> Railway sync: bd_synced_at records when a mirrored listing
-- was last refreshed from BD; bd_sync_status reconciles removals — a listing BD no longer
-- returns is flipped to 'removed' (soft, never hard-deleted) so it drops off the public map
-- while its history and any confirmed company->seller link are preserved. Default/NULL and
-- 'active' both mean visible (backward compatible with pre-092 rows).

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bd_synced_at   TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bd_sync_status TEXT;  -- NULL | 'active' | 'removed'

CREATE INDEX IF NOT EXISTS idx_organizations_bd_sync
  ON organizations(source, bd_sync_status)
  WHERE source = 'bd_import';

COMMENT ON COLUMN organizations.bd_synced_at   IS 'Last time this mirrored listing was refreshed from Brilliant Directories.';
COMMENT ON COLUMN organizations.bd_sync_status IS 'Reconciliation state of a BD-mirrored listing: NULL/active = present in BD (visible); removed = BD no longer returns it (soft-hidden, link+history preserved).';
