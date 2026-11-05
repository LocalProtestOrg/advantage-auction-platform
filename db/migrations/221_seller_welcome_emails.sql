-- 221_seller_welcome_emails.sql - Professional Seller welcome email, sent once per seller (owner request 2026-11-05).
-- Additive only: one new empty table. The same reliable-outbox pattern as storefront_notifications (migration 204):
-- the row is written INSIDE the Professional Seller enrollment transaction, a sender delivers it with back-off retries,
-- and UNIQUE (seller_profile_id) makes a second welcome for the same seller impossible (repeat submissions, retries,
-- double clicks). Holds only the delivery address and status: no names, phone numbers, tokens or account details.
-- Numbered after 218 to 220 (PR #86, not applied) so the numbers never collide; it does not depend on them.
-- Reverse: DROP TABLE IF EXISTS seller_welcome_emails;

CREATE TABLE IF NOT EXISTS seller_welcome_emails (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_profile_id   UUID NOT NULL REFERENCES seller_profiles(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  recipient_email     TEXT NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 320),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','skipped')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at           TIMESTAMPTZ,
  last_error          TEXT,
  provider_message_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  CONSTRAINT uq_seller_welcome_email_once UNIQUE (seller_profile_id)
);
CREATE INDEX IF NOT EXISTS idx_seller_welcome_emails_ready ON seller_welcome_emails (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_seller_welcome_emails_processing ON seller_welcome_emails (locked_at) WHERE status = 'processing';
