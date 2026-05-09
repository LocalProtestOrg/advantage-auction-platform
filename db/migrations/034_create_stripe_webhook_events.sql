-- Migration: 034_create_stripe_webhook_events.sql
-- Persists processed Stripe event IDs so deduplication survives server restarts.
-- The in-memory Set in paymentService.js remains as a fast-path for within-session dupes.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id           TEXT        PRIMARY KEY,           -- Stripe event ID (evt_...)
  event_type   TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
