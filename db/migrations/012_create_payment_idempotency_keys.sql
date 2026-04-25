-- Migration: 012_create_payment_idempotency_keys.sql
-- DB-backed idempotency store for payment charge-lot route.
-- Replaces in-memory Map for this path so replay protection survives restarts.

CREATE TABLE IF NOT EXISTS payment_idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT        NOT NULL,
  route           TEXT        NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMP   NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_payment_idempotency UNIQUE (idempotency_key, route)
);
