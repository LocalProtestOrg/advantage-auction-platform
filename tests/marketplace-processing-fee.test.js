'use strict';

/**
 * The actual card processing fee (Advantage.Bid's cost record, migration 215). Verified against Stripe test mode
 * (2026-11-09): the charge's balance transaction is EMPTY right after the payment succeeds and appears seconds later, so
 * the immediate attempt finds nothing. A later payment webhook and the five-minute backfill fill it in; a webhook payload
 * without latest_charge (an older account API version) falls back to reading the PaymentIntent. Never charges anything.
 */
const calls = [];
const mockStripe = {
  paymentIntents: { retrieve: jest.fn(async (id) => ({ id, latest_charge: 'ch_for_' + id })) },
  charges: { retrieve: jest.fn(async (id) => (id === 'ch_pending' ? { id, balance_transaction: null } : { id, balance_transaction: { fee: 262 } })) },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));
jest.mock('../src/db', () => ({ query: jest.fn(async (sql, params) => {
  calls.push({ sql, params });
  if (/^\s*SELECT id, stripe_payment_intent_id FROM marketplace_orders/.test(sql)) return { rows: [{ id: 'o1', stripe_payment_intent_id: 'pi_1' }, { id: 'o2', stripe_payment_intent_id: 'pi_2' }] };
  if (/UPDATE marketplace_orders SET processing_fee_cents/.test(sql)) return { rowCount: 1, rows: [] };
  return { rows: [], rowCount: 0 };
}), connect: jest.fn() }));

process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder_not_a_real_key';
const svc = require('../src/services/marketplaceOrderService');
beforeEach(() => { calls.length = 0; mockStripe.paymentIntents.retrieve.mockClear(); });

test('nothing is recorded while Stripe has not attached the fee yet', async () => {
  expect(await svc.recordProcessingFee('o1', 'ch_pending')).toBe(false);
  expect(calls.some((c) => /UPDATE marketplace_orders/.test(c.sql))).toBe(false);
});

test('the fee is recorded once it exists, only where none was recorded before', async () => {
  expect(await svc.recordProcessingFee('o1', 'ch_ready')).toBe(true);
  const upd = calls.find((c) => /UPDATE marketplace_orders/.test(c.sql));
  expect(upd.sql).toMatch(/AND processing_fee_cents IS NULL/);
  expect(upd.params).toEqual(['o1', 262]);
});

test('without a charge id (an older webhook payload) the charge is read from the PaymentIntent', async () => {
  expect(await svc.recordProcessingFee('o1', null, 'pi_9')).toBe(true);
  expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_9');
});

test('the backfill fills every paid order still missing its fee (recent, non-demo, a few at a time)', async () => {
  const out = await svc.backfillProcessingFees({ limit: 10 });
  expect(out).toEqual({ enabled: true, scanned: 2, filled: 2 });
  const sel = calls[0];
  expect(sel.sql).toMatch(/payment_status = 'paid' AND processing_fee_cents IS NULL/);
  expect(sel.sql).toMatch(/COALESCE\(is_demo, false\) = false AND paid_at > now\(\) - interval '30 days'/);
  expect(sel.params).toEqual([10]);
});
