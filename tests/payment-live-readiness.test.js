'use strict';

/**
 * Pre-LIVE auction payment blockers (migration 173):
 *   3. off-session errors that are not declines route the invoice to payment_required (never a log-only throw)
 *   4. retry never dead-ends: an open intent is reused or canceled; raw DB errors never reach the buyer;
 *      auction intents are card-only with MANUAL (server-side) confirmation
 *   5. on-session payment is server-confirmed: prepaid refused (422) before confirm; 3-D Secure round trip;
 *      no client secret in URLs; checkout loads only for the owning buyer
 *   6. disputes: recorded, seller payout held (no money moved), audited, owner alerted
 *   7. refunds: tax reversed in full or proportionally (unique references, idempotent); a payment with no
 *      PaymentIntent is never marked refunded (see refund-integrity.test.js)
 *   8-10. stale tax comment, unsafe scripts guarded, neutral seller email wording
 */

const fs = require('fs');
const path = require('path');

const mockStripe = {
  paymentIntents: { create: jest.fn(), retrieve: jest.fn(), cancel: jest.fn(), confirm: jest.fn() },
  paymentMethods: { retrieve: jest.fn(), list: jest.fn() },
  customers: { retrieve: jest.fn() },
  charges: { retrieve: jest.fn() },
  tax: { transactions: { createReversal: jest.fn() } },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn(async () => {}) }));
jest.mock('../src/services/ownerAlertService', () => ({
  ALERT_TYPES: { SETTLEMENT_EXCEPTION: 'settlement_exception' },
  notifyAdminActionRequired: jest.fn(async () => ({ sent: 1 })),
}));

const db = require('../src/db');
const auditService = require('../src/services/auditService');
const ownerAlert = require('../src/services/ownerAlertService');
const { PREPAID_MESSAGE } = require('../src/services/cardService');
const paymentService = require('../src/services/paymentService');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// A fake transactional client: handlers are [regex, result|fn] pairs; BEGIN/COMMIT/ROLLBACK always succeed.
function fakeClient(handlers = []) {
  const c = {
    query: jest.fn(async (sql, params) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rowCount: 0, rows: [] };
      for (const [re, out] of handlers) if (re.test(sql)) return typeof out === 'function' ? out(sql, params) : out;
      return { rowCount: 0, rows: [] };
    }),
    release: jest.fn(),
  };
  return c;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.connect.mockReset();
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_unit';
  delete process.env.STRIPE_TAX_ENABLED;
});

// ── 3. off-session errors ─────────────────────────────────────────────────────────────────────────
describe('off-session combined charge: non-decline errors route to payment_required', () => {
  function setup() {
    jest.spyOn(paymentService, '_loadCombinedChargeContext').mockResolvedValue({ stripeCustomerId: 'cus_1', verifiedPmId: 'pm_1' });
    const client = fakeClient([[/INSERT INTO payments/, { rows: [{ id: 'pay_1' }] }]]);
    db.connect.mockResolvedValue(client);
    return client;
  }
  afterEach(() => jest.restoreAllMocks());

  test('an invalid/missing customer or card (e.g. a TEST id under LIVE keys) is a failed charge, not a throw', async () => {
    setup();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockStripe.paymentIntents.create.mockRejectedValueOnce(Object.assign(new Error('No such customer'), { type: 'StripeInvalidRequestError', code: 'resource_missing' }));
    const r = await paymentService.chargeCombinedOffSession({ auctionId: 'a1', buyerUserId: 'u1', combinedInvoiceId: 'bai_1', amountCents: 5000 });
    expect(r).toMatchObject({ status: 'failed', paymentId: 'pay_1', reason: 'charge_error:resource_missing' });
    expect(mockStripe.paymentIntents.create.mock.calls[0][0].payment_method_types).toEqual(['card']);
  });

  test('a card decline is still a failed charge with the decline code', async () => {
    setup();
    mockStripe.paymentIntents.create.mockRejectedValueOnce(Object.assign(new Error('declined'), { type: 'StripeCardError', code: 'card_declined' }));
    const r = await paymentService.chargeCombinedOffSession({ auctionId: 'a1', buyerUserId: 'u1', combinedInvoiceId: 'bai_1', amountCents: 5000 });
    expect(r).toMatchObject({ status: 'failed', reason: 'card_declined' });
  });

  test('a transport error is retried ONCE with the same idempotency key (never a second charge)', async () => {
    setup();
    mockStripe.paymentIntents.create
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
      .mockResolvedValueOnce({ id: 'pi_ok', status: 'succeeded' });
    const r = await paymentService.chargeCombinedOffSession({ auctionId: 'a1', buyerUserId: 'u1', combinedInvoiceId: 'bai_1', amountCents: 5000, idempotencyKey: 'combined:bai_1' });
    expect(r).toMatchObject({ status: 'succeeded', intentId: 'pi_ok' });
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(2);
    expect(mockStripe.paymentIntents.create.mock.calls.map((c) => c[1].idempotencyKey)).toEqual(['combined:bai_1', 'combined:bai_1']);
  });

  test('auction close routes any unexpected per-buyer failure to payment_required unless a charge is in flight', () => {
    const src = read('src/services/auctionService.js');
    expect(src).toMatch(/const routePaymentRequired = async/);
    expect(src).toMatch(/catch \(perBuyerErr\)[\s\S]{0,900}routePaymentRequired\(combinedInvoiceId, buyerUserId, 'charge_error'\)/);
    expect(src).toMatch(/status = 'pending' AND payment_intent_id IS NOT NULL/);
  });

  test('a succeeded intent whose id was never attached is recorded via its metadata (money is never lost)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })                                                             // lookup by intent id
      .mockResolvedValueOnce({ rows: [{ id: 'pay_9', lot_id: 'lot_1', auction_id: 'a1', buyer_user_id: 'u1' }] }); // attach by metadata
    const rec = jest.spyOn(paymentService, 'recordPaymentSuccess').mockResolvedValue({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await paymentService._handlePaymentIntentSucceeded({ id: 'pi_x', metadata: { payment_id: 'pay_9', buyer_user_id: 'u1' } });
    expect(db.query.mock.calls[1][0]).toMatch(/SET payment_intent_id = \$1\s+WHERE id = \$2 AND buyer_user_id = \$3 AND payment_intent_id IS NULL/);
    expect(rec).toHaveBeenCalledWith('pay_9', 'pi_x');
  });
});

// ── 4. retry safety ──────────────────────────────────────────────────────────────────────────────
describe('retrying payment never dead-ends and never leaves two payable intents', () => {
  afterEach(() => jest.restoreAllMocks());
  const recent = new Date();

  test('a recent, server-confirmed open intent with the same amount is REUSED (no new payment row)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pay_1', lot_id: 'lot_1', auction_id: 'a1', payment_intent_id: 'pi_1', amount_cents: 1180, sales_tax_cents: 0, taxable_base_cents: 1180, created_at: recent }] });
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_1', status: 'requires_payment_method', confirmation_method: 'manual', amount: 1180 });
    const r = await paymentService.createPaymentIntent('u1', 'a1', 'lot_1', 'k1');
    expect(r).toMatchObject({ id: 'pay_1', reused: true, payment_intent_id: 'pi_1', amount_cents: 1180 });
    expect(r.client_secret).toBeUndefined();
    expect(db.connect).not.toHaveBeenCalled();
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  test('a client-confirmable (automatic) or stale intent is CANCELED and its row retired before a new one', async () => {
    const retire = fakeClient();
    db.connect.mockResolvedValueOnce(retire);
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pay_old', lot_id: 'lot_1', auction_id: 'a1', payment_intent_id: 'pi_old', amount_cents: 1180, created_at: recent }] });
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_old', status: 'requires_payment_method', confirmation_method: 'automatic', amount: 1180 });
    mockStripe.paymentIntents.cancel.mockResolvedValueOnce({ id: 'pi_old', status: 'canceled' });
    const out = await paymentService._resolveOpenIntentsForRetry({ userId: 'u1', auctionId: 'a1', lotId: 'lot_1' });
    expect(out).toBeNull();
    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_old', { cancellation_reason: 'duplicate' });
    expect(retire.query.mock.calls.some(([s]) => /UPDATE payments SET status = 'failed'.*WHERE id = \$1 AND status = 'pending'/.test(s))).toBe(true);
    expect(auditService.logEvent.mock.calls[0][1]).toMatchObject({ eventType: 'payment.intent_superseded' });
  });

  test('an intent unknown under the current keys (other mode) is retired, not reused', async () => {
    db.connect.mockResolvedValueOnce(fakeClient());
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pay_t', payment_intent_id: 'pi_testmode', amount_cents: 100, created_at: recent }] });
    mockStripe.paymentIntents.retrieve.mockRejectedValueOnce(Object.assign(new Error('No such payment_intent'), { type: 'StripeInvalidRequestError', code: 'resource_missing' }));
    expect(await paymentService._resolveOpenIntentsForRetry({ userId: 'u1', auctionId: 'a1', lotId: 'lot_1' })).toBeNull();
    expect(auditService.logEvent.mock.calls[0][1].metadata.reason).toBe('intent_unavailable');
  });

  test('an already-succeeded intent is finalized and the buyer is told it is paid (no second charge)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pay_1', payment_intent_id: 'pi_1', amount_cents: 1180, created_at: recent }] });
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_1', status: 'succeeded', amount: 1180 });
    const fin = jest.spyOn(paymentService, '_handlePaymentIntentSucceeded').mockResolvedValue();
    await expect(paymentService.createPaymentIntent('u1', 'a1', 'lot_1', 'k')).rejects.toMatchObject({ code: 'ALREADY_PAID', userFacing: true });
    expect(fin).toHaveBeenCalled();
  });

  test('a concurrent insert (unique index) becomes a friendly in-progress message, never the DB error', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const c = fakeClient([
      [/SELECT state, winning_buyer_user_id/, { rows: [{ state: 'closed', winning_buyer_user_id: 'u1', winning_amount_cents: 1000 }] }],
      [/SELECT a\.buyer_premium_bps/, { rows: [{ pricing_model: 'legacy', seller_type: 'private', seller_platform_bps: 400 }] }],
      [/INSERT INTO payments/, () => { throw Object.assign(new Error('duplicate key value violates unique constraint "idx_payments_unique_active"'), { code: '23505', severity: 'ERROR' }); }],
    ]);
    db.connect.mockResolvedValueOnce(c);
    const err = await paymentService.createPaymentIntent('u1', 'a1', 'lot_1', 'k').catch((e) => e);
    expect(err).toMatchObject({ code: 'PAYMENT_IN_PROGRESS', userFacing: true, status: 409 });
    expect(err.message).not.toMatch(/duplicate key|constraint/);
  });

  test('combined on-session intents are card-only + manual confirmation; the response carries no client secret', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ auction_id: 'a1', buyer_user_id: 'u1', status: 'payment_required' }] })  // pre-check
      .mockResolvedValueOnce({ rows: [] })                                                                      // no open intents
      .mockResolvedValue({ rows: [], rowCount: 1 });                                                            // attach
    db.connect.mockResolvedValueOnce(fakeClient([
      [/FROM buyer_auction_invoices WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'bai_1', auction_id: 'a1', buyer_user_id: 'u1', hammer_cents: 1000, buyer_premium_cents: 180, total_cents: 1180, status: 'payment_required' }] }],
      [/INSERT INTO payments/, { rows: [{ id: 'pay_c', amount_cents: 1180 }] }],
    ]));
    mockStripe.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_c', client_secret: 'pi_c_secret' });
    const r = await paymentService.createCombinedPaymentIntent('u1', 'bai_1', 'k');
    expect(r).toEqual({ payment_id: 'pay_c', amount_cents: 1180, taxable_base_cents: 1180, sales_tax_cents: 0 });
    expect(mockStripe.paymentIntents.create.mock.calls[0][0]).toMatchObject({ payment_method_types: ['card'], confirmation_method: 'manual' });
  });

  test("another buyer's invoice is refused before any retry handling", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ auction_id: 'a1', buyer_user_id: 'someone_else', status: 'payment_required' }] });
    await expect(paymentService.createCombinedPaymentIntent('u1', 'bai_1', 'k')).rejects.toMatchObject({ code: 'NOT_INVOICE_OWNER', status: 403 });
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  test('the route never surfaces raw database or provider errors', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-only';
    const { publicPaymentError } = require('../src/routes/payments');
    const pg = publicPaymentError(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', severity: 'ERROR' }));
    expect(pg.status).toBe(500); expect(pg.body.message).not.toMatch(/duplicate|constraint/);
    const pv = publicPaymentError(Object.assign(new Error('Stripe: No such customer'), { type: 'StripeInvalidRequestError' }));
    expect(pv.status).toBe(500); expect(pv.body.message).not.toMatch(/stripe/i);
    expect(publicPaymentError(Object.assign(new Error('Tax address needed'), { code: 'BUYER_TAX_ADDRESS_REQUIRED', status: 422 })))
      .toEqual({ status: 422, body: { success: false, code: 'BUYER_TAX_ADDRESS_REQUIRED', message: 'Tax address needed' } });
    expect(publicPaymentError(new Error('Lot must be closed before payment')).body.message).toBe('Lot must be closed before payment');
  });
});

// ── 5. server-confirmed on-session payment ───────────────────────────────────────────────────────
describe('on-session payment is confirmed by the server after the card check', () => {
  afterEach(() => jest.restoreAllMocks());
  const row = { id: 'pay_1', buyer_user_id: 'u1', status: 'pending', amount_cents: 1180, payment_intent_id: 'pi_1', lot_id: 'lot_1', auction_id: 'a1' };
  const openIntent = (over = {}) => ({ id: 'pi_1', status: 'requires_payment_method', amount: 1180, metadata: { payment_id: 'pay_1' }, confirmation_method: 'manual', ...over });

  test('a prepaid card is refused (422, PREPAID_MESSAGE) and the intent is NEVER confirmed', async () => {
    db.query.mockResolvedValueOnce({ rows: [row] });
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce(openIntent());
    mockStripe.paymentMethods.retrieve.mockResolvedValueOnce({ id: 'pm_pp', type: 'card', card: { funding: 'prepaid', brand: 'visa', last4: '0000' } });
    await expect(paymentService.confirmOnSessionPayment('u1', 'pay_1', 'pm_pp'))
      .rejects.toMatchObject({ code: 'PREPAID_NOT_ACCEPTED', status: 422, message: PREPAID_MESSAGE });
    expect(mockStripe.paymentIntents.confirm).not.toHaveBeenCalled();
  });

  test.each(['credit', 'debit', 'unknown'])('a %s card is confirmed server-side; success is finalized', async (funding) => {
    db.query.mockResolvedValueOnce({ rows: [row] });
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce(openIntent());
    mockStripe.paymentMethods.retrieve.mockResolvedValueOnce({ id: 'pm_ok', type: 'card', card: { funding } });
    mockStripe.paymentIntents.confirm.mockResolvedValueOnce(openIntent({ status: 'succeeded' }));
    const fin = jest.spyOn(paymentService, '_handlePaymentIntentSucceeded').mockResolvedValue();
    expect(await paymentService.confirmOnSessionPayment('u1', 'pay_1', 'pm_ok')).toEqual({ status: 'succeeded', payment_id: 'pay_1' });
    expect(mockStripe.paymentIntents.confirm).toHaveBeenCalledWith('pi_1', { payment_method: 'pm_ok' }, expect.any(Object));
    expect(fin).toHaveBeenCalled();
  });

  test('3-D Secure: requires_action returns the client secret; the follow-up call re-checks the card and confirms', async () => {
    db.query.mockResolvedValueOnce({ rows: [row] });
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce(openIntent());
    mockStripe.paymentMethods.retrieve.mockResolvedValueOnce({ id: 'pm_3ds', type: 'card', card: { funding: 'credit' } });
    mockStripe.paymentIntents.confirm.mockResolvedValueOnce(openIntent({ status: 'requires_action', client_secret: 'pi_1_secret' }));
    expect(await paymentService.confirmOnSessionPayment('u1', 'pay_1', 'pm_3ds'))
      .toEqual({ status: 'requires_action', payment_id: 'pay_1', client_secret: 'pi_1_secret' });

    // After handleCardAction the intent is requires_confirmation; the server confirms it (no new card).
    db.query.mockResolvedValueOnce({ rows: [row] });
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce(openIntent({ status: 'requires_confirmation', payment_method: 'pm_3ds' }));
    mockStripe.paymentMethods.retrieve.mockResolvedValueOnce({ id: 'pm_3ds', type: 'card', card: { funding: 'credit' } });
    mockStripe.paymentIntents.confirm.mockResolvedValueOnce(openIntent({ status: 'succeeded' }));
    jest.spyOn(paymentService, '_handlePaymentIntentSucceeded').mockResolvedValue();
    expect(await paymentService.confirmOnSessionPayment('u1', 'pay_1', null)).toEqual({ status: 'succeeded', payment_id: 'pay_1' });
    expect(mockStripe.paymentIntents.confirm.mock.calls[1]).toEqual(['pi_1', {}, expect.any(Object)]);
    expect(mockStripe.paymentMethods.retrieve).toHaveBeenLastCalledWith('pm_3ds');
  });

  test('a decline is a neutral 402 and the payment stays open for another card', async () => {
    db.query.mockResolvedValueOnce({ rows: [row] });
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce(openIntent());
    mockStripe.paymentMethods.retrieve.mockResolvedValueOnce({ id: 'pm_d', type: 'card', card: { funding: 'credit' } });
    mockStripe.paymentIntents.confirm.mockRejectedValueOnce(Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined' }));
    await expect(paymentService.confirmOnSessionPayment('u1', 'pay_1', 'pm_d')).rejects.toMatchObject({ code: 'CARD_DECLINED', status: 402, message: 'Your card was declined.' });
  });

  test("only the owning buyer can load or confirm a payment (same 404 as a missing one)", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...row, buyer_user_id: 'other' }] });
    await expect(paymentService.confirmOnSessionPayment('u1', 'pay_1', 'pm_x')).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND', status: 404 });
    db.query.mockResolvedValueOnce({ rows: [{ ...row, buyer_user_id: 'other' }] });
    await expect(paymentService.getCheckout('u1', 'pay_1')).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND', status: 404 });
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  test('checkout returns display data and never a client secret', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...row, taxable_base_cents: 1100, sales_tax_cents: 80, amount_cents: 1180, lot_title: 'Lamp', lot_number: 7, auction_title: 'Estate' }] });
    const c = await paymentService.getCheckout('u1', 'pay_1');
    expect(c).toMatchObject({ payment_id: 'pay_1', kind: 'lot', payable: true, amount_cents: 1180, sales_tax_cents: 80, taxable_base_cents: 1100, publishable_key: 'pk_test_unit' });
    expect(JSON.stringify(c)).not.toMatch(/secret/);
  });

  test('pages: no client secret in URLs; payment.html uses createPaymentMethod + server confirm + handleCardAction', () => {
    const pay = read('public/payment.html');
    expect(pay).not.toMatch(/params\.get\('client_secret'\)/);
    expect(pay).not.toMatch(/confirmCardPayment/);
    expect(pay).toMatch(/stripe\.createPaymentMethod\(\{ type: 'card', card \}\)/);
    expect(pay).toMatch(/\/api\/payments\/checkout\//);
    expect(pay).toMatch(/stripe\.handleCardAction\(data\.client_secret\)/);
    for (const f of ['public/lot.html', 'public/invoices.html']) {
      const src = read(f);
      expect(src).not.toMatch(/client_secret/);
      expect(src).toMatch(/\/payment\.html\?payment_id=/);
    }
  });
});

// ── 6. disputes ──────────────────────────────────────────────────────────────────────────────────
describe('disputes: record, hold the payout (no money moved), audit, alert', () => {
  const disputeService = require('../src/services/disputeService');
  const evt = (type, over = {}) => ({ id: 'evt_' + type, type, livemode: false,
    data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 5000, currency: 'usd', reason: 'fraudulent', status: 'needs_response', evidence_details: { due_by: 1790000000 }, ...over } } });

  function wire({ settlementStatus = 'approved', inserted = true, holdApplied = false } = {}) {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pay_1', auction_id: 'a1', buyer_user_id: 'u1', lot_id: null, status: 'paid' }] });
    const client = fakeClient([
      [/FROM seller_payouts WHERE auction_id = \$1 FOR UPDATE/, { rows: settlementStatus ? [{ id: 'sp_1', settlement_status: settlementStatus }] : [] }],
      [/INSERT INTO payment_disputes/, { rows: [{ id: 'd_row', payout_hold_applied: holdApplied, inserted }] }],
      [/UPDATE seller_payouts SET settlement_status = 'on_hold'/, { rowCount: settlementStatus === 'paid' ? 0 : 1 }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    return client;
  }

  test('dispute events are dispatched from the idempotent webhook pipeline', async () => {
    const spy = jest.spyOn(disputeService, 'handleDisputeEvent').mockResolvedValue({});
    for (const t of ['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed']) {
      await paymentService._dispatchWebhookEvent(evt(t));
    }
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  test('created: recorded, open payout put ON HOLD, audited, owner alerted — no transfer/refund call', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const client = wire();
    const r = await disputeService.handleDisputeEvent(evt('charge.dispute.created'), {});
    expect(r).toMatchObject({ recorded: true, holdApplied: true, closed: false });
    const hold = client.query.mock.calls.find(([s]) => /UPDATE seller_payouts SET settlement_status = 'on_hold'/.test(s));
    expect(hold[0]).toMatch(/settlement_status NOT IN \('paid', 'void'\)/);
    expect(hold[1][1]).toMatch(/dp_1/);
    const events = auditService.logEvent.mock.calls.map((c) => c[1].eventType);
    expect(events).toEqual(expect.arrayContaining(['settlement.on_hold', 'payment.dispute_opened']));
    expect(ownerAlert.notifyAdminActionRequired).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'dp_1:opened', entityType: 'payment_dispute' }));
    expect(Object.keys(mockStripe)).not.toContain('transfers');
    console.log.mockRestore();
  });

  test('a PAID settlement is never changed; the dispute notes that recovery is an owner decision', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const client = wire({ settlementStatus: 'paid' });
    const r = await disputeService.handleDisputeEvent(evt('charge.dispute.created'), {});
    expect(r.holdApplied).toBe(false);
    expect(client.query.mock.calls.some(([s]) => /UPDATE seller_payouts/.test(s))).toBe(false);
    const note = client.query.mock.calls.find(([s]) => /SET payout_hold_applied = \$2, payout_hold_note = \$3/.test(s));
    expect(note[1][2]).toMatch(/already paid/i);
    console.log.mockRestore();
  });

  test('closed: recorded + alerted once, the hold is NOT released automatically', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const client = wire({ inserted: false, holdApplied: true });
    const r = await disputeService.handleDisputeEvent(evt('charge.dispute.closed', { status: 'won' }), {});
    expect(r.closed).toBe(true);
    expect(client.query.mock.calls.some(([s]) => /UPDATE seller_payouts/.test(s))).toBe(false);
    expect(ownerAlert.notifyAdminActionRequired).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'dp_1:closed' }));
    expect(auditService.logEvent.mock.calls.map((c) => c[1].eventType)).toContain('payment.dispute_closed');
    console.log.mockRestore();
  });

  test('a replayed "updated" does not re-alert and the upsert never reopens a closed dispute', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const client = wire({ inserted: false, holdApplied: true });
    await disputeService.handleDisputeEvent(evt('charge.dispute.updated'), {});
    expect(ownerAlert.notifyAdminActionRequired).not.toHaveBeenCalled();
    const up = client.query.mock.calls.find(([s]) => /INSERT INTO payment_disputes/.test(s));
    expect(up[0]).toMatch(/ON CONFLICT \(stripe_dispute_id\) DO UPDATE/);
    expect(up[0]).toMatch(/payment_disputes\.closed_at IS NOT NULL AND NOT \$14 THEN payment_disputes\.status/);
    console.log.mockRestore();
  });
});

// ── 7. refunds: tax reversal ─────────────────────────────────────────────────────────────────────
describe('refund tax reversal: full or proportional, unique references, idempotent', () => {
  beforeEach(() => { process.env.STRIPE_TAX_ENABLED = 'true'; });
  function taxClient({ prior = { through: 0, n: 0 }, reversalId = null } = {}) {
    const c = fakeClient([
      [/SELECT amount_cents, stripe_tax_transaction_id, stripe_tax_reversal_id FROM payments WHERE id = \$1 FOR UPDATE/, { rows: [{ amount_cents: 10800, stripe_tax_transaction_id: 'tax_tx_1', stripe_tax_reversal_id: reversalId }] }],
      [/FROM payment_tax_reversals WHERE payment_id/, { rows: [prior] }],
    ]);
    db.connect.mockResolvedValueOnce(c);
    return c;
  }

  test('a partial refund reverses proportionally (flat, tax-inclusive, negative) with a unique reference', async () => {
    const c = taxClient();
    mockStripe.tax.transactions.createReversal.mockResolvedValueOnce({ id: 'taxrev_p1' });
    expect(await paymentService._reverseTaxForRefund('pay_1', 5400, 'charge.refunded')).toBe('taxrev_p1');
    expect(mockStripe.tax.transactions.createReversal).toHaveBeenCalledWith(
      { mode: 'partial', original_transaction: 'tax_tx_1', reference: 'refund:pay_1:5400', flat_amount: -5400 },
      { idempotencyKey: 'taxrev:refund:pay_1:5400' });
    const ins = c.query.mock.calls.find(([s]) => /INSERT INTO payment_tax_reversals/.test(s));
    expect(ins[1]).toEqual(['pay_1', 5400, 5400, 'partial', 'refund:pay_1:5400', 'taxrev_p1', 'charge.refunded']);
  });

  test('the second partial reverses only the new delta; the final one completes the total', async () => {
    taxClient({ prior: { through: 5400, n: 1 } });
    mockStripe.tax.transactions.createReversal.mockResolvedValueOnce({ id: 'taxrev_p2' });
    await paymentService._reverseTaxForRefund('pay_1', 10800, 'processRefund');
    expect(mockStripe.tax.transactions.createReversal.mock.calls[0][0]).toEqual(
      { mode: 'partial', original_transaction: 'tax_tx_1', reference: 'refund:pay_1:10800', flat_amount: -5400 });
  });

  test('a first, full refund uses a FULL reversal and records it on the payment', async () => {
    const c = taxClient();
    mockStripe.tax.transactions.createReversal.mockResolvedValueOnce({ id: 'taxrev_full' });
    await paymentService._reverseTaxForRefund('pay_1', 10800, 'processRefund');
    expect(mockStripe.tax.transactions.createReversal.mock.calls[0][0]).toEqual({ mode: 'full', original_transaction: 'tax_tx_1', reference: 'refund:pay_1' });
    expect(c.query.mock.calls.some(([s]) => /SET stripe_tax_reversal_id = \$1 WHERE id = \$2 AND stripe_tax_reversal_id IS NULL/.test(s))).toBe(true);
  });

  test('an already-covered level (e.g. the webhook echo of our own refund) makes no second reversal', async () => {
    taxClient({ prior: { through: 5400, n: 1 } });
    expect(await paymentService._reverseTaxForRefund('pay_1', 5400, 'charge.refunded')).toBeNull();
    taxClient({ reversalId: 'taxrev_full' });
    expect(await paymentService._reverseTaxForRefund('pay_1', 10800, 'charge.refunded')).toBeNull();
    expect(mockStripe.tax.transactions.createReversal).not.toHaveBeenCalled();
  });

  test('a Dashboard (out-of-app) partial refund reconciles the payment AND reverses tax', async () => {
    const recon = fakeClient([[/SELECT id, status, amount_cents, refunded_amount_cents, lot_id, auction_id, stripe_refund_id/,
      { rows: [{ id: 'pay_1', status: 'paid', amount_cents: 10800, refunded_amount_cents: 0, stripe_refund_id: null }] }]]);
    db.connect.mockResolvedValueOnce(recon);
    const rev = jest.spyOn(paymentService, '_reverseTaxForRefund').mockResolvedValue('taxrev');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await paymentService._handleChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 2000, refunds: { data: [{ id: 're_dash' }] } });
    expect(recon.query.mock.calls.some(([s, p]) => /UPDATE payments/.test(s) && p[0] === 'partially_refunded')).toBe(true);
    expect(rev).toHaveBeenCalledWith('pay_1', 2000, 'charge.refunded');
    jest.restoreAllMocks();
  });
});

// ── 8-10. small fixes ────────────────────────────────────────────────────────────────────────────
describe('small fixes', () => {
  test('the tax-exemption comment no longer claims sales tax is inactive', () => {
    const src = read('src/services/taxExemptionService.js');
    expect(src).not.toMatch(/inactive at launch/);
    expect(src).toMatch(/Live tax calculation DOES apply exemptions/);
  });

  test('payment test-data scripts refuse production databases and LIVE keys', () => {
    const { productionReasons } = require('../scripts/lib/nonProdGuard');
    expect(productionReasons({ DATABASE_URL: 'postgres://u@ep-proud-leaf-an8pzkib-pooler.x/db' })).toHaveLength(1);
    expect(productionReasons({ STRIPE_SECRET_KEY: 'sk_live_x' })).toHaveLength(1);
    expect(productionReasons({ STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_PUBLISHABLE_KEY: 'pk_live_x', NODE_ENV: 'production' })).toHaveLength(3);
    expect(productionReasons({ DATABASE_URL: 'postgres://localhost/dev', STRIPE_SECRET_KEY: 'sk_test_x' })).toEqual([]);
    for (const f of ['scripts/seed-payment-test.js', 'scripts/get-payment-url.js']) {
      const lines = read(f).split(/\r?\n/);
      const guard = lines.findIndex((l) => /refuseProduction\(/.test(l));
      const pool = lines.findIndex((l) => /new Pool\(/.test(l));
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(pool === -1 ? Infinity : pool);
    }
  });

  test('the professional seller email does not name the payment provider', () => {
    const emails = require('../src/services/professionalSellerEmails');
    const fn = Object.values(emails).find((v) => typeof v === 'function' && /Application/.test(v.name)) || emails.buildApplicationEmail;
    const m = fn({ companyName: 'Acme Estates', sellerTypeLabel: 'Estate Sale Company' });
    expect(m.html + m.text + m.subject).not.toMatch(/stripe/i);
    expect(m.html + m.text).toMatch(/direct-deposit payouts/i);
  });

  test('migration 173 is additive only and ships with a production-guarded runner', () => {
    const sql = read('db/migrations/173_payment_mode_isolation_disputes.sql');
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS livemode BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payment_disputes/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payment_tax_reversals/);
    const runner = read('scripts/prod-migrate-173.js');
    expect(runner).toMatch(/REFUSE: PRODUCTION endpoint only/);
    expect(runner).toMatch(/no_rows_or_ids_changed/);
  });
});
