-- 176: Pre-launch test records — so TEST-mode history can never be mistaken for, charged as, or paid out as real money.
-- ADDITIVE / NON-BREAKING / IDEMPOTENT. Deletes nothing and moves no money; the flags below change nothing until a record is
-- marked (scripts/reclassify-pre-launch-test-records.js, audited per record and reversible).
--
-- auctions.pre_launch_test: the auction ran before live payments. Every buyer payment path refuses it (no real card can be
-- charged for a test auction after the switch to live keys), and its settlement can never be paid.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS pre_launch_test           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS pre_launch_test_reason    TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS pre_launch_test_marked_at TIMESTAMPTZ;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS pre_launch_test_marked_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- A settlement that is not a liability: 'void' (terminal; never recalculated, approved, held or paid).
ALTER TABLE seller_payouts DROP CONSTRAINT IF EXISTS chk_seller_payouts_settlement_status;
ALTER TABLE seller_payouts ADD CONSTRAINT chk_seller_payouts_settlement_status
  CHECK (settlement_status IN ('pending_review','approved','ready_for_payment','paid','on_hold','void'));
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS void_reason       TEXT;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS voided_at         TIMESTAMPTZ;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
