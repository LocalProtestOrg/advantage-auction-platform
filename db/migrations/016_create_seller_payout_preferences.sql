-- Migration: 016_create_seller_payout_preferences.sql
-- Stores seller payout method preferences (ACH or check).
-- Full bank account details are NOT stored here — only safe last4/name fields.

CREATE TABLE IF NOT EXISTS seller_payout_preferences (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_user_id      UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  payout_method       TEXT        NOT NULL CHECK (payout_method IN ('ach', 'check')),
  ach_account_last4   TEXT,
  ach_routing_last4   TEXT,
  ach_account_name    TEXT,
  check_payee_name    TEXT,
  check_address_line1 TEXT,
  check_address_line2 TEXT,
  check_city          TEXT,
  check_state         TEXT,
  check_postal_code   TEXT,
  is_verified         BOOLEAN     NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_payout_prefs_user ON seller_payout_preferences(seller_user_id);
