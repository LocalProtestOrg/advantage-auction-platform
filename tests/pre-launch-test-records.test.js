'use strict';

/**
 * Pre-launch test records (mig 176, 2026-09-28). Every auction before live payments ran on TEST payments only (owner-
 * confirmed and verified against the provider). Once flagged:
 *   - no buyer can be charged for one (per-lot, combined, off-session at close, checkout load and confirm);
 *   - its settlement can be voided, and a void settlement is never recalculated, adjusted, held or paid;
 *   - the seller sees it as closed with no payout, never as money under review.
 * The reclassification script is dry-run by default, audited per record, reversible, and refuses non-TEST money.
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_unit_only';

jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn(async () => {}) }));

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const paymentService = require('../src/services/paymentService');
const engine = require('../src/services/settlementEngine');
const { SETTLEMENT_STATUS, SETTLEMENT_STATUS_LABEL } = require('../src/lib/settlementPolicy');
const view = require('../src/lib/sellerSettlementView');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// The flag is read inside each path's existing query (no extra round trip), so the mock answers those queries.
const client = { query: jest.fn(), release: jest.fn() };
const answer = (on) => async (sql) => {
  if (/FROM payments p/.test(sql) || /FROM payments WHERE id/.test(sql)) {
    return { rows: [{ id: 'p1', buyer_user_id: 'u1', status: 'pending', amount_cents: 1000, payment_intent_id: 'pi_1', auction_id: 'a1', lot_id: null, pre_launch_test: on }] };
  }
  if (/FROM buyer_auction_invoices WHERE id/.test(sql)) return { rows: [{ auction_id: 'a1', buyer_user_id: 'u1', status: 'payment_required', pre_launch_test: on }] };
  if (/FROM users WHERE id/.test(sql)) return { rows: [{ stripe_customer_id: null, stripe_customer_livemode: false, pre_launch_test: on }] };
  if (/FROM lots WHERE id/.test(sql)) return { rows: [{ state: 'closed', winning_buyer_user_id: 'u1', winning_amount_cents: 1000, pre_launch_test: on }] };
  return { rows: [] };
};
const flagged = (on) => { db.query.mockImplementation(answer(on)); client.query.mockImplementation(answer(on)); };

beforeEach(() => { jest.clearAllMocks(); db.connect.mockResolvedValue(client); });
const insertedPayment = () => [...db.query.mock.calls, ...client.query.mock.calls].some(([sql]) => /INSERT INTO payments/.test(sql));

describe('no buyer can be charged for a pre-launch test auction', () => {
  const TEST_RECORD = { code: 'TEST_RECORD', status: 409, userFacing: true };
  test('per-lot charge refuses before any payment row or provider call, and rolls back', async () => {
    flagged(true);
    await expect(paymentService.createPaymentIntent('u1', 'a1', 'l1', 'k1')).rejects.toMatchObject(TEST_RECORD);
    expect(insertedPayment()).toBe(false);
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
  });
  test('combined "Pay Now" refuses', async () => {
    flagged(true);
    await expect(paymentService.createCombinedPaymentIntent('u1', 'ci1', 'k1')).rejects.toMatchObject(TEST_RECORD);
    expect(insertedPayment()).toBe(false);
  });
  test('the automatic charge at close returns test_record (no charge, no payment-required email)', async () => {
    flagged(true);
    await expect(paymentService.chargeCombinedOffSession({ auctionId: 'a1', buyerUserId: 'u1', combinedInvoiceId: 'ci1', amountCents: 1000 }))
      .resolves.toEqual({ status: 'test_record' });
    expect(insertedPayment()).toBe(false);
    const close = read('src', 'services', 'auctionService.js');
    expect(close).toMatch(/r\.status === 'test_record'\) \{\s*\/\/ Pre-launch test auction/);
  });
  test('checkout load and confirm refuse an open payment', async () => {
    flagged(true);
    await expect(paymentService.getCheckout('u1', 'p1')).rejects.toMatchObject(TEST_RECORD);
    await expect(paymentService.confirmOnSessionPayment('u1', 'p1', 'pm_1')).rejects.toMatchObject(TEST_RECORD);
  });
  test('an unflagged auction is unaffected (checkout loads)', async () => {
    flagged(false);
    await expect(paymentService.getCheckout('u1', 'p1')).resolves.toMatchObject({ payment_id: 'p1', payable: true });
  });
  test('the buyer message is plain and carries no provider name', () => {
    const src = read('src', 'services', 'paymentService.js');
    expect(src).toMatch(/const TEST_RECORD_MESSAGE = 'This auction was a test before launch, so there is nothing to pay\.';/);
  });
});

describe('a void settlement is never paid, recalculated, adjusted or held', () => {
  test('void is a known status with an admin label', () => {
    expect(SETTLEMENT_STATUS.VOID).toBe('void');
    expect(SETTLEMENT_STATUS_LABEL.void).toBe('Void (not payable)');
  });
  test('Mark Paid and Direct Deposit both refuse a void settlement', () => {
    const markPaid = { paymentMethod: 'ach', paymentReference: 'r', paidAt: '2026-10-01', confirmedCompleted: true, finalAmountCents: 1000 };
    expect(() => engine.assertMarkPaidAllowed({ hasSettlementRow: true, settlementStatus: 'void', voidReason: 'test record',
      payoutPreferenceComplete: true, netProceedsCents: 1000 }, markPaid)).toThrow(/void \(not payable\): test record/);
    expect(() => engine.assertPaySellerAllowed({ hasSettlementRow: true, settlementStatus: 'void', payoutMethod: 'ach',
      connectReady: true, netProceedsCents: 1000 }, { confirmedCompleted: true, finalAmountCents: 1000 })).toThrow(/void \(not payable\)/);
  });
  test('recalculation is frozen, adjustments are refused, and a dispute never puts it on hold', () => {
    expect(read('src', 'services', 'settlementEngine.js'))
      .toMatch(/settlement_status === SETTLEMENT_STATUS\.PAID \|\| sp\.settlement_status === SETTLEMENT_STATUS\.VOID\) \{ await client\.query\('ROLLBACK'\); return \{ frozen: true/);
    expect(read('src', 'services', 'settlementAdjustmentService.js')).toMatch(/settlement_status === 'void'\) \{\s*throw new SettlementAdjustmentError/);
    const d = read('src', 'services', 'disputeService.js');
    expect(d).toMatch(/settlement_status NOT IN \('paid', 'void'\)/);
    expect(d).toMatch(/sellerPayout\.settlement_status === 'void'\) \{\s*holdNote = 'Settlement is void/);
  });
  test('the seller sees "Closed - No Payout", never "Under Review"', () => {
    expect(view.sellerStatusLabel('void')).toBe('Closed - No Payout');
  });
});

describe('migration 176 and the reclassification script', () => {
  test('migration is additive: flag columns, void columns, and the widened status check', () => {
    const sql = read('db', 'migrations', '176_pre_launch_test_records.sql');
    expect(sql).toMatch(/ALTER TABLE auctions ADD COLUMN IF NOT EXISTS pre_launch_test\s+BOOLEAN NOT NULL DEFAULT false;/);
    expect(sql).toMatch(/CHECK \(settlement_status IN \('pending_review','approved','ready_for_payment','paid','on_hold','void'\)\)/);
    expect(sql.replace(/ON DELETE SET NULL/g, '')).not.toMatch(/\bDELETE\b|\bDROP TABLE\b|\bUPDATE\b/i);
  });
  test('script: production-only, dry run by default, explicit confirm + admin actor, TEST-mode proof, audited, reversible', () => {
    const s = read('scripts', 'reclassify-pre-launch-test-records.js');
    expect(s).toMatch(/REFUSE: PRODUCTION endpoint only/);
    expect(s).toMatch(/if \(doApply && arg\('confirm'\) !== CONFIRM\)/);
    expect(s).toMatch(/REFUSE: --actor must be an admin user id/);
    expect(s).toMatch(/if \(pi\.livemode\) problems\.push/);
    expect(s).toMatch(/if \(tr\.livemode\) problems\.push/);
    expect(s).toMatch(/if \(!v\.ok\) \{ console\.error\('REFUSE: not every record is TEST-mode/);
    expect(s).toMatch(/DRY RUN: nothing changed/);
    expect(s).toMatch(/const EVENT = 'finance\.pre_launch_test_reclassified'/);
    expect(s).toMatch(/async function revert\(/);
    expect(s).not.toMatch(/DELETE FROM/i);
    // Paid history is never rewritten.
    expect(s).toMatch(/settlement_status <> 'paid' AND settlement_status <> 'void'/);
  });
});
