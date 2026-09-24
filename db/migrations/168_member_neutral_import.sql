-- 168_member_neutral_import.sql — ADDITIVE + idempotent.
--
-- MEMBER NEUTRALITY (Owner architectural correction, 2026-09-24). Lewis & Maese is an independent
-- Advantage.Bid member, not a privileged inventory provider. The dedicated L&M importer connector has
-- been removed from the code; this migration retires its source row.
--
--   • import_sources 'lmauction-lewis-maese' → status 'disabled', health RETIRED, retired_reason recorded.
--     The row is KEPT (run history + provenance reference it). It no longer runs, retries or counts
--     toward inventory health, and it is not an action item.
--   • Its imported events are NOT touched: they remain as published/historical records with their
--     original "Lewis & Maese" attribution and original-site links.
--   • L&M's organization, member account, Professional Seller status, events, orders, agreements and
--     negotiated pricing are NOT touched by this migration.
--   • 'RETIRED' joins the source health vocabulary.
--   • The federal surplus source declares config.placeholder_images = true, so image health no longer
--     names a specific source in code.
--
-- Members use the SAME paths as every Professional Seller: their member account, or the generic,
-- consent-gated Member Feed Sync (source 'member-feeds').

BEGIN;

ALTER TABLE import_sources DROP CONSTRAINT IF EXISTS chk_import_sources_health_state;
ALTER TABLE import_sources ADD CONSTRAINT chk_import_sources_health_state CHECK (health_state IS NULL OR health_state IN
  ('HEALTHY','DEGRADED','BROKEN','BLOCKED_BY_SOURCE','NO_LONGER_USEFUL','NEEDS_REVIEW','RETIRED'));

UPDATE import_sources
   SET status = 'disabled',
       config = config || jsonb_build_object(
         'retired_reason', 'dedicated member connector retired (member neutrality, 2026-09-24): members publish through their member account or the generic consent-gated Member Feed Sync',
         'retired_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
       health_state = 'RETIRED',
       health_reason = 'dedicated member connector retired; history kept',
       health_updated_at = now(),
       next_retry_at = NULL,
       retry_count = 0,
       updated_at = now()
 WHERE key = 'lmauction-lewis-maese' AND status <> 'disabled';

UPDATE import_sources
   SET config = config || '{"placeholder_images": true}'::jsonb, updated_at = now()
 WHERE key = 'gsa-auctions' AND NOT (config ? 'placeholder_images');

COMMIT;
