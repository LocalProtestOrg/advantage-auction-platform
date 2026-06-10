// Unit tests for the Stripe webhook state machine in src/services/paymentService.js
//
// Mocks src/db so the tests do not touch a real database. Each test re-requires
// paymentService via jest.resetModules() to reset the module-scoped in-memory
// dedup Set between tests.
//
// What these tests guarantee about claim-after-process semantics:
//   1. A brand-new event is INSERTed as 'received', dispatched, and finalized 'processed'.
//   2. After processed finalization, the in-memory cache is warmed; a re-delivery hits
//      the fast path with no DB read and no dispatch.
//   3. A duplicate event whose DB row is already 'processed' is skipped (no dispatch).
//   4. A legacy row (payload IS NULL — pre-migration / deploy-window) is treated as
//      processed and backfilled. Dispatch is NOT called.
//   5. An event whose DB row is 'failed' is reclaimed (status→received, attempt_count++)
//      and re-dispatched.
//   6. An event whose DB row is 'received' AND recent is treated as in_flight: dispatch
//      is NOT called; no finalize is attempted.
//   7. An event whose DB row is 'received' AND > STALE_IN_FLIGHT_SECONDS old is taken over
//      and re-dispatched.
//   8. If the dispatch throws, finalize is called with 'failed' (and the error message
//      is persisted), then the original error is rethrown so the route returns 500.

jest.mock('../src/db');

describe('paymentService webhook state machine', () => {
  let paymentService;
  let db;

  // Helpers to assert what SQL was issued to db.query
  function findInsert(calls) {
    return calls.find(c => /INSERT INTO stripe_webhook_events/.test(c[0]));
  }
  function findSelect(calls) {
    return calls.find(c => /SELECT status, received_at, attempt_count/.test(c[0]));
  }
  function findUpdateToProcessed(calls) {
    return calls.find(c => /UPDATE stripe_webhook_events[\s\S]*status = 'processed', processed_at = now\(\)/.test(c[0]));
  }
  function findUpdateToFailed(calls) {
    return calls.find(c => /UPDATE stripe_webhook_events[\s\S]*status = 'failed', last_error/.test(c[0]));
  }
  function findFailedReclaim(calls) {
    return calls.find(c => /UPDATE stripe_webhook_events[\s\S]*SET status = 'received',\s*attempt_count = attempt_count \+ 1,\s*last_error = NULL,\s*received_at = now\(\)\s*WHERE id = \$1 AND status = 'failed'/.test(c[0]));
  }
  function findStaleReclaim(calls) {
    return calls.find(c => /UPDATE stripe_webhook_events[\s\S]*WHERE id = \$1 AND status = 'received' AND received_at = \$2/.test(c[0]));
  }
  function findLegacyBackfill(calls) {
    return calls.find(c => /UPDATE stripe_webhook_events[\s\S]*WHERE id = \$1 AND payload IS NULL/.test(c[0]));
  }

  function event(id = 'evt_test_1', type = 'payment_intent.succeeded') {
    return { id, type, data: { object: { id: 'pi_test_1', metadata: {} } } };
  }

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/db');
    db.query = jest.fn();
    db.connect = jest.fn();
    paymentService = require('../src/services/paymentService');
    // Stub the dispatcher so we exercise only the state machine. Individual
    // handlers (recordPaymentSuccess, _handleChargeRefunded, etc.) are covered
    // by their own integration paths and the live Stripe CLI verification.
    jest.spyOn(paymentService, '_dispatchWebhookEvent').mockResolvedValue(undefined);
  });

  // ── 1. Brand-new event ─────────────────────────────────────────────────────
  test('new event → INSERT received → dispatch → finalize processed', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 1 })        // acquire INSERT succeeds
      .mockResolvedValueOnce({ rowCount: 1 });       // finalize UPDATE → processed

    await paymentService.handleWebhookEvent(event('evt_new_1'));

    const calls = db.query.mock.calls;
    expect(findInsert(calls)).toBeDefined();
    expect(findInsert(calls)[1][0]).toBe('evt_new_1');     // event id
    expect(findUpdateToProcessed(calls)).toBeDefined();
    expect(paymentService._dispatchWebhookEvent).toHaveBeenCalledTimes(1);
  });

  // ── 2. In-memory fast path on re-delivery ──────────────────────────────────
  test('after processed, second delivery hits in-memory fast path (no DB, no dispatch)', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 1 })   // first acquire
      .mockResolvedValueOnce({ rowCount: 1 });  // first finalize

    await paymentService.handleWebhookEvent(event('evt_warm_1'));

    db.query.mockClear();
    paymentService._dispatchWebhookEvent.mockClear();

    await paymentService.handleWebhookEvent(event('evt_warm_1'));

    expect(db.query).not.toHaveBeenCalled();
    expect(paymentService._dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  // ── 3. Duplicate already 'processed' in DB ─────────────────────────────────
  test('duplicate already processed in DB → skip', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 0 })  // acquire INSERT conflicts
      .mockResolvedValueOnce({                 // SELECT existing row
        rows: [{ status: 'processed', received_at: new Date(), attempt_count: 1, legacy_row: false }]
      });

    await paymentService.handleWebhookEvent(event('evt_dup_1'));

    expect(paymentService._dispatchWebhookEvent).not.toHaveBeenCalled();
    const calls = db.query.mock.calls;
    expect(findUpdateToProcessed(calls)).toBeUndefined();
    expect(findUpdateToFailed(calls)).toBeUndefined();
  });

  // ── 4. Legacy row (payload null) ───────────────────────────────────────────
  test('legacy row (payload null) → backfill + skip', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 0 })  // acquire INSERT conflicts
      .mockResolvedValueOnce({                 // SELECT — legacy row
        rows: [{ status: 'received', received_at: new Date(), attempt_count: 1, legacy_row: true }]
      })
      .mockResolvedValueOnce({ rowCount: 1 }); // legacy backfill UPDATE

    await paymentService.handleWebhookEvent(event('evt_legacy_1'));

    expect(paymentService._dispatchWebhookEvent).not.toHaveBeenCalled();
    const calls = db.query.mock.calls;
    expect(findLegacyBackfill(calls)).toBeDefined();
  });

  // ── 5. Failed row → reclaim + dispatch ─────────────────────────────────────
  test('failed row → reclaim (status→received, attempt_count++) → dispatch → processed', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 0 })   // acquire INSERT conflicts
      .mockResolvedValueOnce({                  // SELECT existing row
        rows: [{ status: 'failed', received_at: new Date(), attempt_count: 2, legacy_row: false }]
      })
      .mockResolvedValueOnce({ rowCount: 1 })   // failed-reclaim UPDATE
      .mockResolvedValueOnce({ rowCount: 1 });  // finalize processed

    await paymentService.handleWebhookEvent(event('evt_failed_1'));

    expect(paymentService._dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    const calls = db.query.mock.calls;
    expect(findFailedReclaim(calls)).toBeDefined();
    expect(findUpdateToProcessed(calls)).toBeDefined();
  });

  // ── 6. Recent in-flight → in_flight (no dispatch, no finalize) ─────────────
  test('recent in-flight → in_flight: no dispatch, no finalize', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 0 })   // acquire INSERT conflicts
      .mockResolvedValueOnce({                  // SELECT — recent received
        rows: [{ status: 'received', received_at: new Date(), attempt_count: 1, legacy_row: false }]
      });

    await paymentService.handleWebhookEvent(event('evt_inflight_1'));

    expect(paymentService._dispatchWebhookEvent).not.toHaveBeenCalled();
    const calls = db.query.mock.calls;
    expect(findUpdateToProcessed(calls)).toBeUndefined();
    expect(findUpdateToFailed(calls)).toBeUndefined();
  });

  // ── 7. Stale in-flight → take over + dispatch ──────────────────────────────
  test('stale received (older than 300s) → take over → dispatch → processed', async () => {
    const ancient = new Date(Date.now() - 600 * 1000); // 10 minutes old
    db.query
      .mockResolvedValueOnce({ rowCount: 0 })   // acquire INSERT conflicts
      .mockResolvedValueOnce({                  // SELECT — stale received
        rows: [{ status: 'received', received_at: ancient, attempt_count: 1, legacy_row: false }]
      })
      .mockResolvedValueOnce({ rowCount: 1 })   // stale-reclaim UPDATE
      .mockResolvedValueOnce({ rowCount: 1 });  // finalize processed

    await paymentService.handleWebhookEvent(event('evt_stale_1'));

    expect(paymentService._dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    const calls = db.query.mock.calls;
    expect(findStaleReclaim(calls)).toBeDefined();
    expect(findUpdateToProcessed(calls)).toBeDefined();
  });

  // ── 8. Dispatch throws → finalize failed → rethrow ─────────────────────────
  test('dispatch throws → row finalized as failed with error message → rethrows', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 1 })   // acquire INSERT succeeds
      .mockResolvedValueOnce({ rowCount: 1 });  // finalize UPDATE → failed

    paymentService._dispatchWebhookEvent.mockRejectedValueOnce(new Error('synthetic handler failure'));

    await expect(paymentService.handleWebhookEvent(event('evt_throw_1'))).rejects.toThrow('synthetic handler failure');

    const calls = db.query.mock.calls;
    const failedCall = findUpdateToFailed(calls);
    expect(failedCall).toBeDefined();
    expect(failedCall[1][1]).toContain('synthetic handler failure');     // error persisted

    // After failure, in-memory cache must NOT be warmed (or a re-delivery would
    // be wrongly treated as processed). Verify by issuing a second delivery
    // and confirming we go back to the DB rather than the in-memory fast path.
    db.query.mockClear();
    paymentService._dispatchWebhookEvent.mockClear();
    paymentService._dispatchWebhookEvent.mockResolvedValueOnce(undefined);
    db.query
      .mockResolvedValueOnce({ rowCount: 0 })  // second-delivery INSERT conflicts
      .mockResolvedValueOnce({                 // SELECT — finds failed row
        rows: [{ status: 'failed', received_at: new Date(), attempt_count: 1, legacy_row: false }]
      })
      .mockResolvedValueOnce({ rowCount: 1 }) // reclaim
      .mockResolvedValueOnce({ rowCount: 1 }); // finalize processed
    await paymentService.handleWebhookEvent(event('evt_throw_1'));
    expect(paymentService._dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    const calls2 = db.query.mock.calls;
    expect(findFailedReclaim(calls2)).toBeDefined();
    expect(findUpdateToProcessed(calls2)).toBeDefined();
  });
});
