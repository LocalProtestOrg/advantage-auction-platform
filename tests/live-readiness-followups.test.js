'use strict';

/**
 * Pre-LIVE follow-ups (2026-09-27):
 *   1. A seller is never paid while the settlement is on hold or a payment dispute is open.
 *   2. An off-session charge whose outcome is unknown is never re-billed on a guess: it is reconciled by
 *      repeating the exact request with the same idempotency key (or looking it up after the key window).
 *   3. The appraiser billing portal treats a customer from the other key mode as "no billing account".
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_unit_only';

jest.mock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() }));
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn(async () => {}) }));
jest.mock('../src/services/combinedInvoiceService', () => ({
  markFailed: jest.fn(async () => {}), stillUnpaid: jest.fn(async () => true), settleCombined: jest.fn(async () => ({ settled: true })),
}));
jest.mock('../src/services/combinedReceiptService', () => ({ sendPaymentRequired: jest.fn(async () => {}), sendSuccessPackage: jest.fn(async () => {}) }));

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const combinedInvoiceService = require('../src/services/combinedInvoiceService');
const combinedReceiptService = require('../src/services/combinedReceiptService');
const engine = require('../src/services/settlementEngine');
const reconciler = require('../src/services/combinedChargeReconciler');

beforeEach(() => jest.clearAllMocks());

// ── 1. payout holds ─────────────────────────────────────────────────────────────────────────────────
describe('a seller is never paid while on hold or disputed', () => {
  const markPaidInput = { paymentMethod: 'ach', paymentReference: 'ref-1', paidAt: '2026-10-01', confirmedCompleted: true, finalAmountCents: 1000 };
  const markPaidState = { hasSettlementRow: true, payoutPreferenceComplete: true, netProceedsCents: 1000 };
  const payInput = { confirmedCompleted: true, finalAmountCents: 1000 };
  const payState = { hasSettlementRow: true, payoutMethod: 'ach', connectReady: true, netProceedsCents: 1000 };
  test('Mark Paid refuses an on-hold settlement and an open dispute; allows otherwise', () => {
    expect(() => engine.assertMarkPaidAllowed({ ...markPaidState, settlementStatus: 'on_hold', onHoldReason: 'payment dispute dp_1' }, markPaidInput)).toThrow(/on hold \(payment dispute dp_1\)/);
    expect(() => engine.assertMarkPaidAllowed({ ...markPaidState, settlementStatus: 'approved', openDisputes: 1 }, markPaidInput)).toThrow(/dispute is open/);
    expect(engine.assertMarkPaidAllowed({ ...markPaidState, settlementStatus: 'approved', openDisputes: 0 }, markPaidInput)).toEqual({ ok: true });
  });
  test('Direct-deposit Pay Seller refuses an on-hold settlement and an open dispute', () => {
    expect(() => engine.assertPaySellerAllowed({ ...payState, settlementStatus: 'on_hold' }, payInput)).toThrow(/on hold/);
    expect(() => engine.assertPaySellerAllowed({ ...payState, settlementStatus: 'approved', openDisputes: 2 }, payInput)).toThrow(/dispute is open/);
    expect(engine.assertPaySellerAllowed({ ...payState, settlementStatus: 'approved', openDisputes: 0 }, payInput)).toEqual({ ok: true });
  });
  test('both payout paths count open disputes on a separate connection before paying', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'settlementEngine.js'), 'utf8');
    expect((src.match(/const openDisputes = await countOpenDisputes\(db, auctionId\);/g) || []).length).toBe(2);
    expect(src).toMatch(/closed_at IS NULL AND status NOT IN \('won', 'lost', 'warning_closed'\)/);
  });
});

// ── 2. uncertain off-session charges ────────────────────────────────────────────────────────────────
describe('uncertain off-session charges are reconciled, never re-billed on a guess', () => {
  test('the charge path records an unknown outcome and returns "uncertain" without failing the payment', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'paymentService.js'), 'utf8');
    const block = src.slice(src.indexOf('UNKNOWN OUTCOME'), src.indexOf("return { status: 'uncertain', paymentId };") + 40);
    expect(block).toMatch(/if \(isTransientProviderError\(stripeErr\)\)/);
    expect(block).toMatch(/eventType: 'payment\.charge_uncertain'/);
    expect(block).toMatch(/idempotency_key: stripeKey, create_params: createParams/);
    expect(block).not.toMatch(/SET status = 'failed'/);
    const close = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'auctionService.js'), 'utf8');
    expect(close).toMatch(/r\.status === 'uncertain'/);
  });

  const row = (over = {}) => Object.assign({
    payment_id: 'p1', auction_id: 'a1', buyer_user_id: 'u1', within_window: true,
    metadata: { combined_invoice_id: 'ci1', idempotency_key: 'combined:ci1', create_params: { amount: 11800, currency: 'usd', customer: 'cus_1', payment_method: 'pm_1', off_session: true, confirm: true } },
  }, over);
  const setRows = (rows) => db.query.mockImplementation(async (sql) => {
    if (/to_regclass/.test(sql)) return { rows: [{ t: 'payments' }] };
    if (/payment\.charge_uncertain/.test(sql)) return { rows };
    return { rows: [], rowCount: 1 };
  });

  test('within the key window: repeats the SAME request with the SAME key; a succeeded result settles the invoice', async () => {
    setRows([row()]);
    const create = jest.fn(async () => ({ id: 'pi_1', status: 'succeeded' }));
    const out = await reconciler.reconcileUncertainCharges({ stripe: { paymentIntents: { create } } });
    expect(create).toHaveBeenCalledWith(row().metadata.create_params, expect.objectContaining({ idempotencyKey: 'combined:ci1' }));
    expect(combinedInvoiceService.settleCombined).toHaveBeenCalledWith('ci1', 'pi_1', 'p1');
    expect(combinedReceiptService.sendSuccessPackage).toHaveBeenCalledWith('ci1');
    expect(combinedReceiptService.sendPaymentRequired).not.toHaveBeenCalled();
    expect(out).toMatchObject({ considered: 1, settled: 1 });
  });
  test('a decline goes to the normal payment-required path (email + reminders)', async () => {
    setRows([row()]);
    const create = jest.fn(async () => { throw Object.assign(new Error('declined'), { type: 'StripeCardError', code: 'card_declined', raw: { payment_intent: { id: 'pi_2' } } }); });
    const out = await reconciler.reconcileUncertainCharges({ stripe: { paymentIntents: { create } } });
    expect(combinedInvoiceService.markFailed).toHaveBeenCalledWith('ci1', 'charge_after_uncertain');
    expect(combinedReceiptService.sendPaymentRequired).toHaveBeenCalledWith('ci1', 1);
    expect(out.payment_required).toBe(1);
  });
  test('provider still unreachable: nothing changes, nothing is sent', async () => {
    setRows([row()]);
    const create = jest.fn(async () => { throw Object.assign(new Error('down'), { type: 'StripeConnectionError' }); });
    const out = await reconciler.reconcileUncertainCharges({ stripe: { paymentIntents: { create } } });
    expect(out.still_unknown).toBe(1);
    expect(combinedInvoiceService.markFailed).not.toHaveBeenCalled();
    expect(combinedReceiptService.sendPaymentRequired).not.toHaveBeenCalled();
  });
  test('after the key window: never repeats the charge; looks it up; a found success settles', async () => {
    setRows([row({ within_window: false })]);
    const create = jest.fn();
    const search = jest.fn(async () => ({ data: [{ id: 'pi_9', status: 'succeeded' }] }));
    const out = await reconciler.reconcileUncertainCharges({ stripe: { paymentIntents: { create, search } } });
    expect(create).not.toHaveBeenCalled();
    expect(search.mock.calls[0][0].query).toBe("metadata['payment_id']:'p1'");
    expect(out.settled).toBe(1);
  });
  test('after the key window and not found: it was never charged, so the buyer is asked to pay', async () => {
    setRows([row({ within_window: false })]);
    const search = jest.fn(async () => ({ data: [] }));
    const out = await reconciler.reconcileUncertainCharges({ stripe: { paymentIntents: { create: jest.fn(), search } } });
    expect(combinedInvoiceService.markFailed).toHaveBeenCalledWith('ci1', 'never_charged');
    expect(out.payment_required).toBe(1);
  });
  test('an invoice already paid elsewhere is never sent a payment request', async () => {
    setRows([row({ within_window: false })]);
    combinedInvoiceService.stillUnpaid.mockResolvedValueOnce(false);
    await reconciler.reconcileUncertainCharges({ stripe: { paymentIntents: { create: jest.fn(), search: jest.fn(async () => ({ data: [] })) } } });
    expect(combinedReceiptService.sendPaymentRequired).not.toHaveBeenCalled();
  });
  test('the reconciler runs from the notification worker every 5 minutes', () => {
    const w = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'notificationWorker.js'), 'utf8');
    expect(w).toMatch(/setInterval\(runCombinedChargeReconcile, COMBINED_RECONCILE_INTERVAL_MS\)/);
  });
});

// ── 3. billing portal mode check ──────────────────────────────────────────────────────────────────────
describe('appraiser billing portal', () => {
  test('a stored customer from the other key mode is "no billing account", not a provider failure', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'appraiserMembershipService.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function createBillingPortalSession'), src.indexOf('billingPortal.sessions.create'));
    expect(fn).toMatch(/stripe\.customers\.retrieve\(customerId\)/);
    expect(fn).toMatch(/err\.code === 'resource_missing'[\s\S]*code = 'NO_CUSTOMER'/);
  });
});
