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
//   6. An event whose DB row is 'received' AND recent is treated as in_flight: the
//      atomic takeover UPDATE matches no row (rowCount 0), so dispatch is NOT called
//      and no finalize is attempted — a fresh in-flight delivery is never stolen.
//   7. An event whose DB row is 'received' AND > STALE_IN_FLIGHT_SECONDS old is taken over
//      (atomic conditional UPDATE matches, rowCount 1) and re-dispatched.
//   8. If the dispatch throws, finalize is called with 'failed' (and the error message
//      is persisted), then the original error is rethrown so the route returns 500.
//
// DEFECT-LINEB-1 regression guarantees (added 2026-06-11):
//   9. The stale-takeover claim is an atomic server-side predicate
//      (`received_at < now() - interval`), NOT a JS-Date `received_at = $2` equality.
//      The ms/µs precision mismatch that made that equality never match — and the
//      function recurse unbounded — cannot recur.
//  10. The acquire path is a bounded loop: under pathological transient churn it can
//      never spin unbounded; it bails after MAX_ACQUIRE_ATTEMPTS and acknowledges.

jest.mock('../src/db');

describe('paymentService webhook state machine', () => {
  let paymentService;
  let db;

  // Helpers to assert what SQL was issued to db.query
  function findInsert(calls) {
    return calls.find(c => /INSERT INTO stripe_webhook_events/.test(c[0]));
  }
  function findSelect(calls) {
    return calls.find(c => /SELECT status, \(payload IS NULL\) AS legacy_row/.test(c[0]));
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
    // Atomic server-side takeover: claims a 'received' row only if it is older than
    // the stale threshold, evaluated entirely in Postgres (no JS Date equality).
    return calls.find(c => /UPDATE stripe_webhook_events[\s\S]*status = 'received'[\s\S]*received_at < now\(\) - interval/.test(c[0]));
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
  // The takeover UPDATE is always issued for a 'received' row; for a FRESH row its
  // server-side staleness predicate matches nothing (rowCount 0) → the row is NOT
  // stolen and we acknowledge as in_flight.
  test('recent in-flight (fresh) → in_flight: takeover matches nothing, no dispatch, no finalize', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 0 })   // acquire INSERT conflicts
      .mockResolvedValueOnce({                  // SELECT — received
        rows: [{ status: 'received', legacy_row: false }]
      })
      .mockResolvedValueOnce({ rowCount: 0 });  // takeover UPDATE matches nothing (fresh)

    await paymentService.handleWebhookEvent(event('evt_inflight_1'));

    expect(paymentService._dispatchWebhookEvent).not.toHaveBeenCalled();
    const calls = db.query.mock.calls;
    expect(findStaleReclaim(calls)).toBeDefined();        // takeover WAS attempted
    expect(findUpdateToProcessed(calls)).toBeUndefined(); // but did not process
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

  // ── 9. DEFECT-LINEB-1: stale received is acquired via a server-side predicate, ──
  //       NOT a JS-Date equality. This is what makes takeover immune to the
  //       millisecond/microsecond precision mismatch that previously wedged it.
  test('stale received → takeover uses server-side `received_at < now() - interval`, never `received_at = $2`', async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 0 })   // acquire INSERT conflicts
      .mockResolvedValueOnce({                  // SELECT — received row (no received_at needed in JS)
        rows: [{ status: 'received', legacy_row: false }]
      })
      .mockResolvedValueOnce({ rowCount: 1 })   // takeover UPDATE claims the stale row
      .mockResolvedValueOnce({ rowCount: 1 });  // finalize processed

    await paymentService.handleWebhookEvent(event('evt_precision_1'));

    const calls = db.query.mock.calls;
    const takeover = findStaleReclaim(calls);
    expect(takeover).toBeDefined();
    // The fragile equality guard must be gone, and no timestamp may be passed as a
    // bound parameter to the takeover (it took $2 = row.received_at before the fix).
    expect(takeover[0]).toMatch(/received_at < now\(\) - interval '\d+ seconds'/);
    expect(takeover[0]).not.toMatch(/received_at = \$2/);
    expect(Array.isArray(takeover[1]) ? takeover[1] : []).toHaveLength(1); // only $1 = eventId
    expect(paymentService._dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(findUpdateToProcessed(calls)).toBeDefined();
  });

  // ── 10. DEFECT-LINEB-1: the acquire path is bounded — it can never spin unbounded. ──
  //       Simulate pathological transient churn: INSERT always conflicts and the row
  //       always disappears before the SELECT. The old recursion would loop forever
  //       (test would hang). The bounded loop must terminate and acknowledge.
  test('pathological churn → acquire terminates (bounded), no dispatch, no unbounded loop', async () => {
    db.query.mockImplementation((sql) => {
      if (/INSERT INTO stripe_webhook_events/.test(sql)) return Promise.resolve({ rowCount: 0 }); // always conflicts
      if (/SELECT status/.test(sql)) return Promise.resolve({ rows: [] });                         // row vanished
      return Promise.resolve({ rowCount: 0 });
    });

    // If this recursed unbounded, the await would never resolve and the test would
    // time out. Reaching the assertions proves the loop is bounded.
    await paymentService.handleWebhookEvent(event('evt_churn_1'));

    expect(paymentService._dispatchWebhookEvent).not.toHaveBeenCalled();
    const insertCalls = db.query.mock.calls.filter(c => /INSERT INTO stripe_webhook_events/.test(c[0]));
    // Retried, but strictly bounded (MAX_ACQUIRE_ATTEMPTS = 5).
    expect(insertCalls.length).toBeGreaterThan(1);
    expect(insertCalls.length).toBeLessThanOrEqual(5);
  });
});
