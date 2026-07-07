-- 084: Design C — Combined Per-Buyer Payment & Settlement (Launch).
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Introduces a combined invoice HEADER (one per
-- buyer+auction) layered OVER the existing per-lot `invoices` table, which is left UNTOUCHED.
-- The header owns the single off-session charge, the single email set, and the combined PDF;
-- per-lot invoices remain as line-item/admin artifacts and are flipped to paid on combined settle.
-- Everything is gated behind COMBINED_INVOICING_ENABLED (default off) — NO behavior change until
-- the flag is set. No destructive changes. Reuses invoice_number_seq. Stripe stays TEST.

-- ── Combined invoice header: one per (buyer, auction) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buyer_auction_invoices (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id               UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  buyer_user_id            UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  invoice_number           TEXT UNIQUE DEFAULT ('AAC-C-' || lpad(nextval('invoice_number_seq')::text, 6, '0')),
  hammer_cents             INTEGER NOT NULL DEFAULT 0,   -- sum of winning lot hammer prices
  buyer_premium_cents      INTEGER NOT NULL DEFAULT 0,   -- $0.00 at launch
  sales_tax_cents          INTEGER NOT NULL DEFAULT 0,   -- $0.00 at launch
  shipping_cents           INTEGER NOT NULL DEFAULT 0,
  credits_cents            INTEGER NOT NULL DEFAULT 0,
  total_cents              INTEGER NOT NULL DEFAULT 0,   -- Grand Total (what is charged once)
  status                   TEXT NOT NULL DEFAULT 'issued'
                           CHECK (status IN ('issued','payment_required','paid','void')),
  payment_id               UUID REFERENCES payments(id),
  stripe_payment_intent_id TEXT,
  charge_attempted_at      TIMESTAMPTZ,
  paid_at                  TIMESTAMPTZ,
  reminders_sent           INTEGER NOT NULL DEFAULT 0,   -- caps at 3 total payment emails
  closed_at                TIMESTAMPTZ NOT NULL DEFAULT now(), -- reminder-timing anchor (auction close)
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bai_auction_buyer ON buyer_auction_invoices(auction_id, buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_bai_unpaid ON buyer_auction_invoices(status) WHERE status = 'payment_required';

COMMENT ON TABLE buyer_auction_invoices IS
  'Design C: one combined invoice header per (buyer, auction); owns the single off-session charge + email set. Per-lot `invoices` remain and are flipped to paid on combined settle. Gated by COMBINED_INVOICING_ENABLED.';

-- ── Guard against a duplicate combined charge ────────────────────────────────────────────────
-- A combined payment is distinguished from a per-lot payment by lot_id IS NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_combined_active
  ON payments(auction_id, buyer_user_id)
  WHERE lot_id IS NULL AND status IN ('pending','paid','refunded','partially_refunded');

-- ── Seller closeout hold bookkeeping ─────────────────────────────────────────────────────────
-- The seller closeout package is HELD (not sent at close) until all buyers paid OR 24h elapsed.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS seller_closeout_sent_at TIMESTAMPTZ;
COMMENT ON COLUMN auctions.seller_closeout_sent_at IS
  'Design C: stamped when the single seller closeout package is sent (all buyers paid OR 24h post-close). Idempotency guard against double-send.';

-- ── notifications_queue.type: add PAYMENT_REMINDER ───────────────────────────────────────────
-- Reminders #2 (+12h) and Final (+24h) are enqueued with a future next_attempt_at (already honored
-- by the worker's claim query). Non-destructive drop-and-recreate, re-enumerating every existing
-- type so no historical row is rejected — same pattern as 083. Widening only.
ALTER TABLE notifications_queue DROP CONSTRAINT IF EXISTS notifications_queue_type_check;
ALTER TABLE notifications_queue ADD CONSTRAINT notifications_queue_type_check
  CHECK (type IN (
    'OUTBID', 'LEADING', 'WINNING', 'ENDING_SOON',
    'CLOSE_TO_WINNING', 'FINAL_SECONDS', 'EXTENDED_BIDDING',
    'NEW_AUCTION', 'AUCTION_RETURNED_TO_DRAFT', 'AUCTION_REJECTED',
    'PICKUP_SCHEDULED', 'PICKUP_REMINDER',
    'PAYMENT_REMINDER'
  ));
