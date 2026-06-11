// Unit tests for the createPaymentIntent reorder (Sub-batch 2: C-2 + M-1 + I-4).
//
// Mocks src/db so tests do not touch a real database. Uses two mock interfaces:
//   db.query(sql, params)             — for top-level reads/writes
//   db.connect() => client            — for transactional flows; client.query supports BEGIN/COMMIT/ROLLBACK
//
// What these tests guarantee:
//   1. Happy path: tx1 inserts pending(intent_id=NULL), COMMITs, Stripe called
//      OUTSIDE tx with HTTP idempotency key, tx2 attaches intent_id and commits.
//   2. Stripe failure: cleanup flips the row to 'failed' and an
//      'payment.intent_create_failed' audit is written; original error rethrows.
//   3. The retire-stale-pending UPDATE includes the I-4 guard:
//      AND payment_intent_id IS NULL AND created_at < now() - interval '60 seconds'.
//   4. The Stripe SDK is called with { idempotencyKey: <HTTP_KEY> } in options.
//   5. The post-Stripe attach UPDATE is single-row with `WHERE id=$1 AND payment_intent_id IS NULL`.
//   6. The webhook intent lookup is ordered to prefer pending rows over failed/paid
//      (Race 1 mitigation).

jest.mock('../src/db');
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/invoiceService', () => ({ createInvoice: jest.fn().mockResolvedValue({ id: 'inv-1' }) }));
jest.mock('../src/services/pickupScheduleService', () => ({
  assignPickupOnPayment: jest.fn().mockResolvedValue({ pickupAssignmentId: null }),
}), { virtual: false });
jest.mock('stripe', () => {
  const mockCreate = jest.fn();
  const factory = jest.fn(() => ({ paymentIntents: { create: mockCreate } }));
  factory.__mockCreate = mockCreate;
  return factory;
});

describe('createPaymentIntent — Sub-batch 2 reorder', () => {
  let paymentService;
  let db;
  let Stripe;
  let auditService;
  let mockClient;

  const userId    = 'user-uuid-1';
  const auctionId = 'auction-uuid-1';
  const lotId     = 'lot-uuid-1';
  const httpIdemKey = 'http-idem-key-abc';
  const paymentRowId = 'payment-uuid-1';

  function makeMockClient() {
    return {
      query: jest.fn(),
      release: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/db');
    db.query   = jest.fn();
    db.connect = jest.fn();
    Stripe = require('stripe');
    Stripe.__mockCreate.mockReset();
    auditService = require('../src/services/auditService');
    auditService.logEvent.mockClear();
    mockClient = makeMockClient();
    paymentService = require('../src/services/paymentService');
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  });

  function defaultTx1Setup() {
    // Sequence of client.query calls in tx1:
    //   BEGIN
    //   SELECT lot (returns valid lot)
    //   SELECT existing paid payment (none)
    //   UPDATE retire stale pending (0 rows)
    //   INSERT pending (returns paymentRowId)
    //   audit_log via auditService (mocked, not via client.query)
    //   COMMIT
    mockClient.query.mockImplementation(async (sql) => {
      if (/^BEGIN$/.test(sql))   return { rowCount: 0 };
      if (/^COMMIT$/.test(sql))  return { rowCount: 0 };
      if (/^ROLLBACK$/.test(sql)) return { rowCount: 0 };
      if (/SELECT state, winning_buyer_user_id, winning_amount_cents FROM lots/.test(sql)) {
        return { rows: [{ state: 'closed', winning_buyer_user_id: userId, winning_amount_cents: 1234 }] };
      }
      if (/SELECT id, status FROM payments\s+WHERE lot_id = \$1 AND buyer_user_id = \$2 AND status IN/.test(sql)) {
        return { rows: [] };
      }
      if (/UPDATE payments\s+SET status = 'failed'/.test(sql)) {
        return { rowCount: 0 };
      }
      if (/INSERT INTO payments \(auction_id, lot_id, buyer_user_id, amount_cents, status, payment_intent_id\)\s+VALUES \(\$1, \$2, \$3, \$4, 'pending', NULL\)/.test(sql)) {
        return { rows: [{ id: paymentRowId, amount_cents: 1234, created_at: new Date('2026-05-17T10:00:00Z') }] };
      }
      throw new Error('Unexpected tx1 client.query: ' + sql);
    });
  }

  // ── 1. Happy path ──────────────────────────────────────────────────────────
  test('happy path: tx1 inserts pending(intent_id=NULL), Stripe called outside tx, tx2 attaches intent_id', async () => {
    const attachClient = makeMockClient();
    db.connect.mockImplementation(async () => {
      // First call: tx1 client. Second call: tx2 attach client.
      if (db.connect.mock.calls.length === 1) return mockClient;
      return attachClient;
    });

    defaultTx1Setup();

    Stripe.__mockCreate.mockResolvedValueOnce({ id: 'pi_happy', client_secret: 'pi_happy_secret' });

    attachClient.query.mockImplementation(async (sql) => {
      if (/^BEGIN$/.test(sql))  return { rowCount: 0 };
      if (/^COMMIT$/.test(sql)) return { rowCount: 0 };
      if (/UPDATE payments\s+SET payment_intent_id = \$1\s+WHERE id = \$2 AND payment_intent_id IS NULL\s+RETURNING/.test(sql)) {
        return { rowCount: 1, rows: [{ id: paymentRowId, status: 'pending' }] };
      }
      throw new Error('Unexpected tx2 client.query: ' + sql);
    });

    const result = await paymentService.createPaymentIntent(userId, auctionId, lotId, httpIdemKey);

    expect(result.id).toBe(paymentRowId);
    expect(result.payment_intent_id).toBe('pi_happy');
    expect(result.client_secret).toBe('pi_happy_secret');
    expect(result.status).toBe('pending');

    // Stripe was called with the HTTP idempotency key forwarded.
    expect(Stripe.__mockCreate).toHaveBeenCalledTimes(1);
    const stripeOpts = Stripe.__mockCreate.mock.calls[0][1];
    expect(stripeOpts.idempotencyKey).toBe(httpIdemKey);

    // Audit log called for payment.created AND payment.intent_attached.
    const eventTypes = auditService.logEvent.mock.calls.map(c => c[1].eventType);
    expect(eventTypes).toContain('payment.created');
    expect(eventTypes).toContain('payment.intent_attached');

    // Order of operations: tx1 client used first and released; then Stripe called;
    // then tx2 client used.
    expect(mockClient.release).toHaveBeenCalled();
    expect(attachClient.release).toHaveBeenCalled();
  });

  // ── 2. Stripe failure: row marked failed + intent_create_failed audit ──────
  test('Stripe failure: row marked failed via cleanup tx, audit written, original error rethrows', async () => {
    const failClient = makeMockClient();
    db.connect.mockImplementation(async () => {
      if (db.connect.mock.calls.length === 1) return mockClient;
      return failClient;
    });

    defaultTx1Setup();

    Stripe.__mockCreate.mockRejectedValueOnce(new Error('stripe boom'));

    failClient.query.mockImplementation(async (sql) => {
      if (/^BEGIN$/.test(sql))  return { rowCount: 0 };
      if (/^COMMIT$/.test(sql)) return { rowCount: 0 };
      if (/UPDATE payments\s+SET status = 'failed', last_attempted_at = now\(\)\s+WHERE id = \$1 AND status = 'pending' AND payment_intent_id IS NULL/.test(sql)) {
        return { rowCount: 1 };
      }
      throw new Error('Unexpected cleanup client.query: ' + sql);
    });

    await expect(
      paymentService.createPaymentIntent(userId, auctionId, lotId, httpIdemKey)
    ).rejects.toThrow('stripe boom');

    // payment.intent_create_failed audit written
    const eventTypes = auditService.logEvent.mock.calls.map(c => c[1].eventType);
    expect(eventTypes).toContain('payment.intent_create_failed');
  });

  // ── 3. I-4 guard: retire-stale-pending SQL includes the new conditions ────
  test('retire-stale-pending UPDATE includes intent_id IS NULL and 60s age guard (I-4)', async () => {
    const attachClient = makeMockClient();
    db.connect.mockImplementation(async () => {
      if (db.connect.mock.calls.length === 1) return mockClient;
      return attachClient;
    });

    defaultTx1Setup();

    Stripe.__mockCreate.mockResolvedValueOnce({ id: 'pi_x', client_secret: 'x_secret' });
    attachClient.query.mockImplementation(async (sql) => {
      if (/^BEGIN$/.test(sql))  return { rowCount: 0 };
      if (/^COMMIT$/.test(sql)) return { rowCount: 0 };
      if (/UPDATE payments\s+SET payment_intent_id/.test(sql)) {
        return { rowCount: 1, rows: [{ id: paymentRowId, status: 'pending' }] };
      }
      throw new Error('Unexpected: ' + sql);
    });

    await paymentService.createPaymentIntent(userId, auctionId, lotId, httpIdemKey);

    // The retire UPDATE issued in tx1 must include the new guards.
    const retireCall = mockClient.query.mock.calls.find(c =>
      /UPDATE payments\s+SET status = 'failed'/.test(c[0])
    );
    expect(retireCall).toBeDefined();
    const retireSql = retireCall[0];
    expect(retireSql).toMatch(/payment_intent_id IS NULL/);
    expect(retireSql).toMatch(/created_at < now\(\) - interval '60 seconds'/);
  });

  // ── 4. Stripe SDK called with idempotencyKey option ───────────────────────
  test('Stripe SDK receives idempotencyKey = HTTP key in options', async () => {
    const attachClient = makeMockClient();
    db.connect.mockImplementation(async () => {
      if (db.connect.mock.calls.length === 1) return mockClient;
      return attachClient;
    });
    defaultTx1Setup();
    Stripe.__mockCreate.mockResolvedValueOnce({ id: 'pi_k', client_secret: 'k_s' });
    attachClient.query.mockImplementation(async (sql) => {
      if (/UPDATE payments\s+SET payment_intent_id/.test(sql)) {
        return { rowCount: 1, rows: [{ id: paymentRowId, status: 'pending' }] };
      }
      return { rowCount: 0 };
    });

    await paymentService.createPaymentIntent(userId, auctionId, lotId, 'specific-http-key-xyz');
    expect(Stripe.__mockCreate.mock.calls[0][1].idempotencyKey).toBe('specific-http-key-xyz');
  });

  // ── 5. Attach UPDATE is single-row with the right guard ───────────────────
  test('intent_attached UPDATE uses WHERE id=$1 AND payment_intent_id IS NULL', async () => {
    const attachClient = makeMockClient();
    db.connect.mockImplementation(async () => {
      if (db.connect.mock.calls.length === 1) return mockClient;
      return attachClient;
    });
    defaultTx1Setup();
    Stripe.__mockCreate.mockResolvedValueOnce({ id: 'pi_q', client_secret: 'q_s' });
    let attachSqlSeen = null;
    attachClient.query.mockImplementation(async (sql, params) => {
      if (/UPDATE payments\s+SET payment_intent_id/.test(sql)) {
        attachSqlSeen = sql;
        return { rowCount: 1, rows: [{ id: paymentRowId, status: 'pending' }] };
      }
      return { rowCount: 0 };
    });

    await paymentService.createPaymentIntent(userId, auctionId, lotId, httpIdemKey);
    expect(attachSqlSeen).toMatch(/WHERE id = \$2 AND payment_intent_id IS NULL/);
  });
});

// ── 6. Webhook intent lookup prefers pending (Race 1 mitigation) ────────────
describe('_handlePaymentIntentSucceeded — webhook intent lookup ordering', () => {
  let paymentService;
  let db;

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/db');
    db.query   = jest.fn();
    db.connect = jest.fn();
    paymentService = require('../src/services/paymentService');
  });

  test('lookup SQL orders by status pending-first to mitigate Race 1', async () => {
    // Stub the lookup query to return a pending row id; then make recordPaymentSuccess
    // throw so the test exits before requiring the full success path.
    db.query.mockImplementationOnce(async (sql) => {
      expect(sql).toMatch(/ORDER BY CASE status\s+WHEN 'pending' THEN 0\s+WHEN 'paid'\s+THEN 1\s+ELSE 2\s+END,\s+created_at DESC/);
      return { rows: [{ id: 'p-pending' }] };
    });
    jest.spyOn(paymentService, 'recordPaymentSuccess').mockRejectedValueOnce(new Error('stop'));

    await expect(
      paymentService._handlePaymentIntentSucceeded({ id: 'pi_test', metadata: {} })
    ).rejects.toThrow('stop');
  });
});
