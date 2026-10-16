-- Rollback for 202_taxpayer_id_minimization.sql (reviewed; run only with owner approval). Removes the constraints and the
-- status columns added by 202. It does NOT restore any EIN (none was stored or removed by 202).
BEGIN;
ALTER TABLE seller_identity DROP CONSTRAINT IF EXISTS seller_identity_no_full_ein;
ALTER TABLE seller_identity DROP CONSTRAINT IF EXISTS seller_identity_taxpayer_last4_format;
ALTER TABLE seller_identity DROP CONSTRAINT IF EXISTS seller_identity_taxpayer_id_source_check;
ALTER TABLE seller_identity DROP CONSTRAINT IF EXISTS seller_identity_taxpayer_id_status_check;
ALTER TABLE seller_identity DROP COLUMN IF EXISTS taxpayer_id_verified_at;
ALTER TABLE seller_identity DROP COLUMN IF EXISTS taxpayer_id_last4;
ALTER TABLE seller_identity DROP COLUMN IF EXISTS taxpayer_id_source;
ALTER TABLE seller_identity DROP COLUMN IF EXISTS taxpayer_id_status;
DELETE FROM schema_migrations WHERE filename = '202_taxpayer_id_minimization.sql';
COMMIT;
-- NOTE: the code deployed with 202 reads the taxpayer_id_* columns; roll the code back first.
