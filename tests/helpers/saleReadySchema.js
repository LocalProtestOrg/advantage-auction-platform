'use strict';

/**
 * Test-schema addition for real-database storefront checkout tests (PGlite harnesses that create their own minimal
 * users/seller_profiles tables). A storefront order needs a seller whose agreement is in place and whose payout account
 * can be paid (sellerSaleEligibility, 2026-11-02). Here every test seller starts READY: the agreement is waived and a
 * connected (test-mode) payout account is created with the seller. A test that needs a not-ready seller turns either
 * off explicitly (UPDATE seller_profiles SET agreement_waived_at = NULL / UPDATE seller_payout_preferences ...).
 * Applied after the harness creates seller_profiles. Test data only.
 */
const SALE_READY_SQL = `
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS agreement_waived_at timestamptz DEFAULT now();
ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS agreement_waived_by uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false;
CREATE TABLE IF NOT EXISTS seller_payout_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_user_id uuid UNIQUE, payout_method text,
  stripe_account_id text, stripe_account_livemode boolean DEFAULT false, connect_status text,
  connect_details_submitted boolean DEFAULT false, connect_transfers_active boolean DEFAULT false, connect_payouts_enabled boolean DEFAULT false,
  connect_disabled_reason text, connect_bank_name text, connect_bank_last4 text,
  check_payee_name text, check_address_line1 text, check_city text, check_state text, check_postal_code text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
-- A harness may already have its own smaller version of the table: add whatever is missing.
ALTER TABLE seller_payout_preferences ADD COLUMN IF NOT EXISTS payout_method text;
ALTER TABLE seller_payout_preferences ADD COLUMN IF NOT EXISTS stripe_account_id text;
ALTER TABLE seller_payout_preferences ADD COLUMN IF NOT EXISTS stripe_account_livemode boolean DEFAULT false;
ALTER TABLE seller_payout_preferences ADD COLUMN IF NOT EXISTS connect_status text;
ALTER TABLE seller_payout_preferences ADD COLUMN IF NOT EXISTS connect_details_submitted boolean DEFAULT false;
ALTER TABLE seller_payout_preferences ADD COLUMN IF NOT EXISTS connect_transfers_active boolean DEFAULT false;
ALTER TABLE seller_payout_preferences ADD COLUMN IF NOT EXISTS connect_payouts_enabled boolean DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS test_sale_ready_payouts_user ON seller_payout_preferences (seller_user_id);
-- What the agreement check reads when a seller has no waiver (agreementService.dashboardAccess).
CREATE TABLE IF NOT EXISTS agreement_template_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), template_id uuid);
CREATE TABLE IF NOT EXISTS agreements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_profile_id uuid, template_version_id uuid,
  status text, signed_at timestamptz, created_at timestamptz DEFAULT now());
DO $$ BEGIN
  IF to_regclass('auctions') IS NOT NULL THEN ALTER TABLE auctions ADD COLUMN IF NOT EXISTS state text DEFAULT 'draft'; END IF;
END $$;
CREATE OR REPLACE FUNCTION test_sale_ready_payouts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO seller_payout_preferences (seller_user_id, payout_method, stripe_account_id, connect_status, connect_details_submitted,
                                         connect_transfers_active, connect_payouts_enabled)
  VALUES (NEW.user_id, 'ach', 'acct_test_' || replace(NEW.id::text, '-', ''), 'ready', true, true, true)
  ON CONFLICT (seller_user_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS test_sale_ready_payouts ON seller_profiles;
CREATE TRIGGER test_sale_ready_payouts AFTER INSERT ON seller_profiles FOR EACH ROW EXECUTE FUNCTION test_sale_ready_payouts();
`;

module.exports = { SALE_READY_SQL };
