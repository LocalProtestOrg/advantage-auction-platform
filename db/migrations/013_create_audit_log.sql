-- Migration: 013_create_audit_log.sql
-- Append-only audit log for key platform state transitions.
-- No foreign keys — rows must survive even if referenced entities are deleted.

CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT      NOT NULL,
  entity_type  TEXT      NOT NULL,
  entity_id    UUID      NOT NULL,
  auction_id   UUID,
  lot_id       UUID,
  payment_id   UUID,
  actor_id     UUID,
  metadata     JSONB,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_auction_id ON audit_log (auction_id);
CREATE INDEX idx_audit_log_created_at ON audit_log (created_at DESC);
