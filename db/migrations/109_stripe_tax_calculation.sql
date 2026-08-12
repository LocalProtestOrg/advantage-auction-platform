-- 109_stripe_tax_calculation.sql
--
-- Stripe Tax (Calculation API) support for auction buyer payments. ADDITIVE ONLY —
-- every column is nullable / defaulted, so this is production-safe and idempotent and
-- changes NO behavior on its own. The whole tax pipeline is gated at runtime by the
-- STRIPE_TAX_ENABLED env flag (default OFF); with the flag off these columns simply
-- stay NULL/0 exactly as today.
--
-- Owner-approved Version 1.0 tax policy this supports:
--   • Jurisdiction  = BUYER address (not pickup). Buyer tax-address columns below.
--   • Taxable base  = hammer + buyer premium (persisted per payment for audit).
--   • Seller payout = tax EXCLUDED (settlement engine already excludes it; unchanged).
--
-- Note: payments.sales_tax_cents already exists (migration 072); invoices.sales_tax_cents
-- (072) and buyer_auction_invoices.sales_tax_cents (084) also already exist. This migration
-- only adds the Stripe Tax reference/provenance columns and the buyer tax-address fields.

-- ── Per-payment Stripe Tax provenance (reconciliation + idempotent transaction recording) ──
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS taxable_base_cents        INTEGER,       -- hammer + buyer premium the tax was computed on
  ADD COLUMN IF NOT EXISTS stripe_tax_calculation_id TEXT,          -- tax.calculations id used to set the charge amount
  ADD COLUMN IF NOT EXISTS stripe_tax_transaction_id TEXT,          -- tax.transactions id recorded on payment success
  ADD COLUMN IF NOT EXISTS stripe_tax_reversal_id    TEXT;          -- tax.transactions reversal id recorded on full refund

-- ── Buyer tax address (jurisdiction evidence for the Stripe Tax calculation) ──
-- Collected/confirmed by the buyer BEFORE the taxed payment. Not card data. Only what
-- Stripe Tax needs for jurisdiction: line1/2, city, state, postal code, country.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tax_address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS tax_address_line2 TEXT,
  ADD COLUMN IF NOT EXISTS tax_city          TEXT,
  ADD COLUMN IF NOT EXISTS tax_state         TEXT,
  ADD COLUMN IF NOT EXISTS tax_postal_code   TEXT,
  ADD COLUMN IF NOT EXISTS tax_country       TEXT;
