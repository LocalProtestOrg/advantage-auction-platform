// Unit tests for processRefund Sub-batch 2 reorder (C-3 + M-1 + C-4 + I.3).
//
// Covers:
//   1. Happy path: tx1 admin-check + status-guard + overspend-guard + look-back-guard +
//      refund_started audit + COMMIT; Stripe called outside tx with idempotency key;
//      tx2 UPDATE payments + refunded audit + COMMIT.
//   2. Stripe failure: refund_failed audit written; payment row unchanged; original error thrown.
//   3. 30-second look-back guard rejects concurrent attempt with REFUND_IN_PROGRESS code.
//   4. Overspend guard rejects refundAmountCents + prior refunded > amount_cents.
//   5. Seeded path (payment_intent_id NULL): skips Stripe call, still updates DB.
//   6. Stripe SDK called with options.idempotencyKey equal to provided refund key.

jest.mock('../src/db');
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/invoiceService', () => ({ createInvoice: jest.fn() }));
jest.mock('stripe', () => {
  const mockRefundCreate = jest.fn();
  const factory = jest.fn(() => ({ refunds: { create: mockRefundCreate } }));
  factory.__mockRefundCreate = mockRefundCreate;
  return factory;
});

describe('processRefund — Sub-batch 2 reorder', () => {
  let paymentService;
  let db;
  let Stripe;
  let auditService;

  const adminId    = 'admin-uuid-1';
  const paymentId  = 'payment-uuid-1';
  const auctionId  = 'auction-uuid-1';
  const lotId      = 'lot-uuid-1';
  const intentId   = 'pi_existing_abc';
  const idemKey    = 'refund-key-xyz';

  function makeClient() {
    return { query: jest.fn(), release: jest.fn() };
  }

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/db');
    db.query   = jest.fn();
    db.connect = jest.fn();
    Stripe = require('stripe');
    Stripe.__mockRefundCreate.mockReset();
    auditService = require('../src/services/auditService');
    auditService.logEvent.mockClear();
    paymentService = require('../src/services/paymentService');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  });

  // Helper: standard tx1 mock for a paid payment with given prior refunded.
  function tx1MocksFor(paymentRow, lookbackHit = false) {
    const c = makeClient();
    c.query.mockImplementation(async (sql) => {
      if (/^BEGIN$/.test(sql))    return { rowCount: 0 };
      if (/^COMMIT$/.test(sql))   return { rowCount: 0 };
      if (/^ROLLBACK$/.test(sql)) return { rowCount: 0 };
      // _ensureAdminRole: SELECT role FROM users WHERE id = $1
      if (/SELECT role FROM users WHERE id/.test(sql)) {
        return { rows: [{ role: 'admin' }] };
      }
      // SELECT FOR UPDATE on payment row
      if (/SELECT status, amount_cents, refunded_amount_cents, payment_intent_id, lot_id, auction_id\s+FROM payments WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [paymentRow] };
      }
      // 30s look-back query
      if (/SELECT 1 FROM audit_log a\s+WHERE a\.payment_id/.test(sql)) {
        return { rows: lookbackHit ? [{ '?column?': 1 }] : [] };
      }
      throw new Error('Unexpected tx1 client.query: ' + sql);
    });
    return c;
  }

  // ── 1. Happy path ──────────────────────────────────────────────────────────
  test('happy path: tx1 → Stripe → tx2; refunded_amount_cents accumulates', async () => {
    const tx1 = tx1MocksFor({
      status: 'paid', amount_cents: 10000, refunded_amount_cents: 0,
      payment_intent_id: intentId, lot_id: lotId, auction_id: auctionId,
    });
    const tx2 = makeClient();
    tx2.query.mockImplementation(async (sql) => {
      if (/^BEGIN$|^COMMIT$/.test(sql)) return { rowCount: 0 };
      if (/UPDATE payments\s+SET status\s+= \$1/.test(sql)) return { rowCount: 1 };
      throw new Error('unexpected tx2: ' + sql);
    });

    db.connect.mockImplementationOnce(async () => tx1)
              .mockImplementationOnce(async () => tx2);

    Stripe.__mockRefundCreate.mockResolvedValueOnce({ id: 're_happy_1' });

    const result = await paymentService.processRefund(adminId, paymentId, 3000, idemKey);

    expect(result.status).toBe('partially_refunded');
    expect(result.refund_amount_cents).toBe(3000);
    expect(result.refunded_amount_cents_total).toBe(3000);
    expect(result.stripe_refund_id).toBe('re_happy_1');

    // Stripe called with the idempotency key.
    expect(Stripe.__mockRefundCreate).toHaveBeenCalledTimes(1);
    expect(Stripe.__mockRefundCreate.mock.calls[0][1].idempotencyKey).toBe(idemKey);

    // Audit log: refund_started AND refunded (no refund_failed).
    const events = auditService.logEvent.mock.calls.map(c => c[1].eventType);
    expect(events).toContain('payment.refund_started');
    expect(events).toContain('payment.refunded');
    expect(events).not.toContain('payment.refund_failed');
  });

  // ── 2. Stripe failure ──────────────────────────────────────────────────────
  test('Stripe failure: refund_failed audit written, payment row unchanged, error thrown', async () => {
    const tx1 = tx1MocksFor({
      status: 'paid', amount_cents: 5000, refunded_amount_cents: 0,
      payment_intent_id: intentId, lot_id: lotId, auction_id: auctionId,
    });
    const failTx = makeClient();
    failTx.query.mockImplementation(async (sql) => {
      if (/^BEGIN$|^COMMIT$/.test(sql)) return { rowCount: 0 };
      throw new Error('unexpected failTx: ' + sql);
    });
    db.connect.mockImplementationOnce(async () => tx1)
              .mockImplementationOnce(async () => failTx);

    Stripe.__mockRefundCreate.mockRejectedValueOnce(new Error('stripe network err'));

    await expect(
      paymentService.processRefund(adminId, paymentId, 2000, idemKey)
    ).rejects.toThrow('Stripe refund failed: stripe network err');

    const events = auditService.logEvent.mock.calls.map(c => c[1].eventType);
    expect(events).toContain('payment.refund_started');
    expect(events).toContain('payment.refund_failed');
    expect(events).not.toContain('payment.refunded');
  });

  // ── 3. 30s look-back rejects concurrent attempt ───────────────────────────
  test('30s look-back hit → REFUND_IN_PROGRESS error before any Stripe call', async () => {
    const tx1 = tx1MocksFor({
      status: 'paid', amount_cents: 5000, refunded_amount_cents: 0,
      payment_intent_id: intentId, lot_id: lotId, auction_id: auctionId,
    }, /* lookbackHit */ true);
    db.connect.mockImplementationOnce(async () => tx1);

    await expect(
      paymentService.processRefund(adminId, paymentId, 1000, idemKey)
    ).rejects.toMatchObject({ code: 'REFUND_IN_PROGRESS' });

    // No Stripe call, no refund_started audit (rejected before write).
    expect(Stripe.__mockRefundCreate).not.toHaveBeenCalled();
    const events = auditService.logEvent.mock.calls.map(c => c[1].eventType);
    expect(events).not.toContain('payment.refund_started');
  });

  // ── 4. Overspend guard ────────────────────────────────────────────────────
  test('overspend guard: refundAmountCents + prior refunded > amount_cents → rejected before Stripe', async () => {
    const tx1 = tx1MocksFor({
      status: 'partially_refunded', amount_cents: 10000, refunded_amount_cents: 7000,
      payment_intent_id: intentId, lot_id: lotId, auction_id: auctionId,
    });
    db.connect.mockImplementationOnce(async () => tx1);

    await expect(
      paymentService.processRefund(adminId, paymentId, 4000, idemKey)
    ).rejects.toThrow(/Refund total would exceed payment amount/);

    expect(Stripe.__mockRefundCreate).not.toHaveBeenCalled();
  });

  // ── 5. Seeded path (no payment_intent_id) ─────────────────────────────────
  test('seeded path: Stripe call skipped, DB still updated, stripe_refund_id stays null', async () => {
    const tx1 = tx1MocksFor({
      status: 'paid', amount_cents: 4000, refunded_amount_cents: 0,
      payment_intent_id: null, lot_id: lotId, auction_id: auctionId,
    });
    const tx2 = makeClient();
    tx2.query.mockImplementation(async (sql) => {
      if (/^BEGIN$|^COMMIT$/.test(sql)) return { rowCount: 0 };
      if (/UPDATE payments\s+SET status\s+= \$1/.test(sql)) return { rowCount: 1 };
      throw new Error('unexpected tx2: ' + sql);
    });
    db.connect.mockImplementationOnce(async () => tx1)
              .mockImplementationOnce(async () => tx2);

    const result = await paymentService.processRefund(adminId, paymentId, 4000, idemKey);

    expect(Stripe.__mockRefundCreate).not.toHaveBeenCalled();
    expect(result.status).toBe('refunded');
    expect(result.stripe_refund_id).toBeNull();
    expect(result.refunded_amount_cents_total).toBe(4000);
  });

  // ── 6. Idempotency key forwarded to Stripe ────────────────────────────────
  test('Stripe SDK receives options.idempotencyKey equal to the supplied refund key', async () => {
    const tx1 = tx1MocksFor({
      status: 'paid', amount_cents: 8000, refunded_amount_cents: 0,
      payment_intent_id: intentId, lot_id: lotId, auction_id: auctionId,
    });
    const tx2 = makeClient();
    tx2.query.mockImplementation(async () => ({ rowCount: 1 }));
    db.connect.mockImplementationOnce(async () => tx1)
              .mockImplementationOnce(async () => tx2);
    Stripe.__mockRefundCreate.mockResolvedValueOnce({ id: 're_ik_test' });

    await paymentService.processRefund(adminId, paymentId, 1500, 'unique-refund-key-987');

    expect(Stripe.__mockRefundCreate.mock.calls[0][1].idempotencyKey).toBe('unique-refund-key-987');
  });

  // ── 7. Cumulative full-refund detection ───────────────────────────────────
  test('cumulative refund completing the total → status becomes refunded (not partially_refunded)', async () => {
    const tx1 = tx1MocksFor({
      status: 'partially_refunded', amount_cents: 10000, refunded_amount_cents: 7000,
      payment_intent_id: intentId, lot_id: lotId, auction_id: auctionId,
    });
    const tx2 = makeClient();
    tx2.query.mockImplementation(async () => ({ rowCount: 1 }));
    db.connect.mockImplementationOnce(async () => tx1)
              .mockImplementationOnce(async () => tx2);
    Stripe.__mockRefundCreate.mockResolvedValueOnce({ id: 're_final' });

    const result = await paymentService.processRefund(adminId, paymentId, 3000, idemKey);
    expect(result.status).toBe('refunded');
    expect(result.refunded_amount_cents_total).toBe(10000);
  });
});
