-- Migration: 063_add_stripe_customer_and_pm.sql
-- #20 STEP 4 Card-on-file. A buyer must have a saved/verified payment method
-- (via Stripe SetupIntent, TEST mode) before registering/bidding. No charge is
-- made — the card is saved for later auction settlement.
--
-- users.stripe_customer_id : the buyer's Stripe Customer (created on demand).
-- card_verifications.stripe_payment_method_id : the saved PM id (pm_...). The
--   existing card_id column is UUID and cannot hold a Stripe id, so add a TEXT
--   column. A 'verified' card_verifications row is the local card-on-file marker.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

ALTER TABLE card_verifications
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT;
