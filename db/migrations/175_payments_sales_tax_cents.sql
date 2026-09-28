-- 175: payments.sales_tax_cents — the per-payment sales tax the Stripe Tax pipeline records.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Migration 109 assumed this column already existed on `payments` (it cited
-- 072), but 072 added sales_tax_cents to `invoices` only. With STRIPE_TAX_ENABLED=true every taxed auction charge
-- (off-session at close and on-session checkout) therefore failed with 42703 before any card was charged.
-- Default 0 matches every existing row: no auction payment has ever carried a tax calculation. No money is moved.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS sales_tax_cents INTEGER NOT NULL DEFAULT 0;
