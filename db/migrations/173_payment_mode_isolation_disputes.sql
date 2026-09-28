-- 173_payment_mode_isolation_disputes.sql
-- Auction payment readiness before the payment provider goes LIVE. ADDITIVE ONLY: no drops, no
-- rewrites of existing values except stamping the NEW mode columns on existing rows as TEST (false).
--
-- 1. TEST/LIVE isolation. Every stored provider reference is stamped with the mode it was created in.
--    Lookups use only current-mode records, so after the switch to LIVE keys every buyer adds a card again
--    and every seller sets up direct deposit again, automatically. Old TEST ids are KEPT (history) and
--    simply ignored; a replaced id is copied into a superseded_* column before being overwritten.
-- 2. Payment disputes (chargebacks) are recorded, one row per provider dispute id.
-- 3. Sales-tax reversals for refunds (full or partial, from the app or from outside it) are recorded, one
--    row per cumulative refunded level, so each reversal is made exactly once.

-- ── 1. Mode stamps ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_customer_livemode       BOOLEAN,
  ADD COLUMN IF NOT EXISTS superseded_stripe_customer_id  TEXT;
UPDATE users SET stripe_customer_livemode = false
 WHERE stripe_customer_id IS NOT NULL AND stripe_customer_livemode IS NULL;

ALTER TABLE card_verifications
  ADD COLUMN IF NOT EXISTS livemode BOOLEAN NOT NULL DEFAULT false;   -- existing rows → TEST

ALTER TABLE seller_payout_preferences
  ADD COLUMN IF NOT EXISTS stripe_account_livemode       BOOLEAN,
  ADD COLUMN IF NOT EXISTS stripe_bank_account_livemode  BOOLEAN,
  ADD COLUMN IF NOT EXISTS superseded_stripe_account_id  TEXT;
UPDATE seller_payout_preferences SET stripe_account_livemode = false
 WHERE stripe_account_id IS NOT NULL AND stripe_account_livemode IS NULL;
UPDATE seller_payout_preferences SET stripe_bank_account_livemode = false
 WHERE stripe_bank_account_ref IS NOT NULL AND stripe_bank_account_livemode IS NULL;

CREATE INDEX IF NOT EXISTS idx_card_verifications_user_mode
  ON card_verifications (user_id, livemode) WHERE status = 'verified';

-- ── 2. Disputes ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_disputes (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_dispute_id    TEXT        NOT NULL,
  stripe_charge_id     TEXT,
  payment_intent_id    TEXT,
  payment_id           UUID        REFERENCES payments(id) ON DELETE SET NULL,
  auction_id           UUID        REFERENCES auctions(id) ON DELETE SET NULL,
  buyer_user_id        UUID        REFERENCES users(id) ON DELETE SET NULL,
  seller_payout_id     UUID        REFERENCES seller_payouts(id) ON DELETE SET NULL,
  amount_cents         INTEGER,
  currency             TEXT,
  reason               TEXT,
  status               TEXT        NOT NULL,          -- provider dispute status (needs_response, won, lost, …)
  livemode             BOOLEAN     NOT NULL DEFAULT false,
  evidence_due_by      TIMESTAMPTZ,
  payout_hold_applied  BOOLEAN     NOT NULL DEFAULT false,
  payout_hold_note     TEXT,                          -- why a hold was / was not applied
  opened_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at            TIMESTAMPTZ,
  last_event_id        TEXT,
  last_event_type      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_disputes_stripe_dispute ON payment_disputes (stripe_dispute_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_payment ON payment_disputes (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_auction ON payment_disputes (auction_id);
CREATE INDEX IF NOT EXISTS idx_payment_disputes_open    ON payment_disputes (status) WHERE closed_at IS NULL;

-- ── 3. Sales-tax reversals for refunds ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_tax_reversals (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id              UUID        NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  refunded_through_cents  INTEGER     NOT NULL,        -- cumulative refunded amount this reversal covers up to
  reversal_amount_cents   INTEGER     NOT NULL,        -- refunded amount reversed by THIS row (tax-inclusive)
  mode                    TEXT        NOT NULL CHECK (mode IN ('full', 'partial')),
  reference               TEXT        NOT NULL,        -- unique provider reference
  stripe_tax_reversal_id  TEXT,
  source                  TEXT,                        -- processRefund | charge.refunded
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_payment_tax_reversals_amount CHECK (reversal_amount_cents > 0 AND refunded_through_cents > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_tax_reversals_level ON payment_tax_reversals (payment_id, refunded_through_cents);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_tax_reversals_reference ON payment_tax_reversals (reference);
