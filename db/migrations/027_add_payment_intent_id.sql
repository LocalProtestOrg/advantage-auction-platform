-- Stores the Stripe PaymentIntent ID so webhooks can look up the payment row.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_intent_id TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_payments_intent_id ON payments(payment_intent_id);
