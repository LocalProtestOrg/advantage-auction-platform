-- 139_owner_alert_recipient_hash.sql — per-recipient idempotency for OWNER OPERATIONAL SMS.
-- ADDITIVE + idempotent + production-safe. Adds a non-reversible recipient HASH so delivery state is
-- tracked PER RECIPIENT (dedup_key now = alert_type:entity_id:recipient_hash), ensuring one recipient's
-- delivery/skip never suppresses another recipient's alert. NO phone number is ever stored — only a
-- SHA-256 prefix. Existing single-recipient rows (dedup_key = alert_type:entity_id) remain valid.

ALTER TABLE owner_alert_log ADD COLUMN IF NOT EXISTS recipient_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_owner_alert_log_recipient ON owner_alert_log(alert_type, recipient_hash);
