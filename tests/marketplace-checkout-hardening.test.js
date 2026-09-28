'use strict';

/**
 * Professional Storefront checkout hardening (pre-LIVE):
 *  1. a charge that succeeds after the order lost its hold is auto-refunded (never a stuck webhook)
 *  2. expired holds are swept (intent checked first; succeeded/processing never released)
 *  3. payment_failed does not release the item
 *  4. /config is public; everything else keeps auth
 *  5. quote is gated behind the checkout flag
 *  6. tax reversal references are unique; partial/outside refunds reverse proportionally; jurisdiction rules
 *  7. prepaid cards are refused server-side before any charge; the intent needs server confirmation
 *  9. the 11% fee base excludes shipping and tax
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-storefront-hardening';

let mockClient = null;
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/utils/withTransaction', () => ({ withTransaction: (fn) => fn(mockClient) }));
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn(async () => {}) }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
jest.mock('../src/services/marketplaceOrderNotifier', () => ({
  sendPaid: jest.fn(async () => {}), sendRefunded: jest.fn(async () => {}), sendConflictRefunded: jest.fn(async () => {}),
}));
jest.mock('../src/services/taxCalculationService', () => ({
  taxEnabled: jest.fn(() => false),
  addressComplete: (a) => !!(a && a.line1 && a.city && a.state && a.postal_code),
  computeTax: jest.fn(async () => ({ enabled: false, taxCents: 0, calculationId: null, exempt: false })),
  recordTransaction: jest.fn(async () => null),
  reverseFullTransaction: jest.fn(async () => 'taxrev_full'),
  reversePartialTransaction: jest.fn(async () => 'taxrev_partial'),
}));
const mockStripe = {
  paymentIntents: {
    create: jest.fn(async () => ({ id: 'pi_1', client_secret: 'cs_1', status: 'requires_payment_method' })),
    retrieve: jest.fn(),
    cancel: jest.fn(async (id) => ({ id, status: 'canceled' })),
    confirm: jest.fn(),
  },
  refunds: { create: jest.fn(async () => ({ id: 're_1' })) },
  paymentMethods: { retrieve: jest.fn() },
  tax: { transactions: { createReversal: jest.fn(async () => ({ id: 'taxrev_x' })) } },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

const db = require('../src/db');
const audit = require('../src/services/auditService');
const notifier = require('../src/services/marketplaceOrderNotifier');
const tax = require('../src/services/taxCalculationService');
const svc = require('../src/services/marketplaceOrderService');
const { PREPAID_MESSAGE } = require('../src/services/cardService');

// A tiny SQL router shared by db.query and the transaction client. Records every statement.
function fakeDb(routes) {
  const calls = [];
  const query = async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    for (const [re, res] of routes) if (re.test(flat)) return typeof res === 'function' ? res(params, flat) : res;
    return { rows: [], rowCount: 0 };
  };
  return { query, calls, has: (re) => calls.some((c) => re.test(c.sql)), find: (re) => calls.filter((c) => re.test(c.sql)) };
}
function install(routes) {
  const f = fakeDb(routes);
  db.query.mockImplementation(f.query);
  mockClient = { query: f.query };
  return f;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MARKETPLACE_CHECKOUT_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  tax.taxEnabled.mockImplementation(() => false);
  tax.computeTax.mockImplementation(async () => ({ enabled: false, taxCents: 0, calculationId: null, exempt: false }));
});

const ORDER = (over = {}) => ({
  id: 'o1', order_number: 'MO-001001', marketplace_item_id: 'item-1', seller_id: 'seller-1', buyer_user_id: 'buyer-1',
  item_price_cents: 10000, shipping_cents: 1000, tax_cents: 0, platform_fee_bps: 1100, platform_fee_cents: 1100,
  seller_proceeds_cents: 9900, total_charge_cents: 11000, fulfillment_method: 'pickup', payment_status: 'pending',
  refund_status: 'none', refunded_amount_cents: 0, stripe_payment_intent_id: 'pi_1', stripe_tax_transaction_id: null,
  ...over,
});
const INTENT = (over = {}) => ({ id: 'pi_1', status: 'succeeded', amount: 11000, amount_received: 11000, latest_charge: 'ch_1', ...over });

// ── 1. markOrderPaid conflict safety ────────────────────────────────────────────────────────────────
describe('markOrderPaid: conflict auto-refund', () => {
  function routesFor(order, item) {
    return [
      [/FROM marketplace_orders WHERE stripe_payment_intent_id = \$1 FOR UPDATE/, { rows: [order] }],
      [/FROM marketplace_items WHERE id = \$1 FOR UPDATE/, { rows: item ? [item] : [] }],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 FOR UPDATE/, { rows: [order] }],
    ];
  }

  test('order already failed (hold expired, item sold to someone else) → refunded, not thrown', async () => {
    const f = install(routesFor(ORDER({ payment_status: 'failed' }), { id: 'item-1', status: 'sold', pending_order_id: null }));
    const out = await svc.markOrderPaid(INTENT());
    expect(out).toEqual({ conflict: true, reason: 'item_sold' });
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', amount: 11000 }, { idempotencyKey: 'mo-conflict-refund:o1' });
    const upd = f.find(/UPDATE marketplace_orders SET payment_status = 'refunded'/)[0];
    expect(upd.params[3]).toBe('conflict:item_sold');
    expect(f.has(/SET payment_status = 'paid'/)).toBe(false);          // never marks paid
    expect(f.has(/UPDATE marketplace_items/)).toBe(false);             // never touches the other buyer's item
    expect(audit.logEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'marketplace_order.conflict_refunded' }));
    expect(notifier.sendConflictRefunded).toHaveBeenCalledWith('o1');
  });

  test('item claimed by ANOTHER order → refunded with that reason', async () => {
    install(routesFor(ORDER({ payment_status: 'failed' }), { id: 'item-1', status: 'pending_purchase', pending_order_id: 'o2' }));
    const out = await svc.markOrderPaid(INTENT());
    expect(out.reason).toBe('item_claimed_by_other_order');
    expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  test('item removed → refunded', async () => {
    install(routesFor(ORDER(), { id: 'item-1', status: 'removed', pending_order_id: null }));
    expect((await svc.markOrderPaid(INTENT())).reason).toBe('item_removed');
  });

  test('an already-refunded order is a no-op (no second refund on webhook replay)', async () => {
    install(routesFor(ORDER({ payment_status: 'refunded', refund_status: 'refunded' }), null));
    await svc.markOrderPaid(INTENT());
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  test('a charge already refunded elsewhere is tolerated (webhook completes)', async () => {
    install(routesFor(ORDER({ payment_status: 'failed' }), { id: 'item-1', status: 'sold' }));
    mockStripe.refunds.create.mockRejectedValueOnce(Object.assign(new Error('already'), { code: 'charge_already_refunded' }));
    await expect(svc.markOrderPaid(INTENT())).resolves.toMatchObject({ conflict: true });
  });

  test('normal path: item held by THIS order → paid + sold, no refund', async () => {
    const f = install(routesFor(ORDER(), { id: 'item-1', status: 'pending_purchase', pending_order_id: 'o1' }));
    await svc.markOrderPaid(INTENT());
    expect(f.has(/SET payment_status = 'paid'/)).toBe(true);
    expect(f.has(/UPDATE marketplace_items SET status = 'sold'/)).toBe(true);
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    expect(notifier.sendPaid).toHaveBeenCalledWith('o1');
  });
});

// ── 2. Expired-hold sweeper ─────────────────────────────────────────────────────────────────────────
describe('sweepExpiredHolds', () => {
  test('does nothing when checkout is disabled', async () => {
    process.env.MARKETPLACE_CHECKOUT_ENABLED = 'false';
    const f = install([]);
    const out = await svc.sweepExpiredHolds();
    expect(out.enabled).toBe(false);
    expect(f.calls.length).toBe(0);
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  test('expired + abandoned intent → intent canceled, item released; succeeded/processing never released', async () => {
    const orders = {
      oA: ORDER({ id: 'oA', marketplace_item_id: 'iA', stripe_payment_intent_id: 'pi_A' }),
      oB: ORDER({ id: 'oB', marketplace_item_id: 'iB', stripe_payment_intent_id: 'pi_B' }),
      oC: ORDER({ id: 'oC', marketplace_item_id: 'iC', stripe_payment_intent_id: 'pi_C' }),
    };
    const f = install([
      [/FROM marketplace_items mi LEFT JOIN marketplace_orders o/, { rows: [
        { item_id: 'iA', order_id: 'oA', stripe_payment_intent_id: 'pi_A' },
        { item_id: 'iB', order_id: 'oB', stripe_payment_intent_id: 'pi_B' },
        { item_id: 'iC', order_id: 'oC', stripe_payment_intent_id: 'pi_C' },
        { item_id: 'iD', order_id: null, stripe_payment_intent_id: null },
      ] }],
      [/SELECT id, payment_status, stripe_payment_intent_id FROM marketplace_orders WHERE id = \$1/, (p) => ({ rows: [orders[p[0]]] })],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 FOR UPDATE/, (p) => ({ rows: [orders[p[0]]] })],
      [/FROM marketplace_orders WHERE stripe_payment_intent_id = \$1 FOR UPDATE/, (p) => ({ rows: [Object.values(orders).find((o) => o.stripe_payment_intent_id === p[0])] })],
      [/FROM marketplace_items WHERE id = \$1 FOR UPDATE/, (p) => ({ rows: [{ id: p[0], status: 'pending_purchase', pending_order_id: 'o' + p[0].slice(1) }] })],
      [/UPDATE marketplace_items SET status = 'active'.*pending_expires_at < now\(\)/, { rowCount: 1, rows: [] }],
    ]);
    const status = { pi_A: 'requires_payment_method', pi_B: 'processing', pi_C: 'succeeded' };
    mockStripe.paymentIntents.retrieve.mockImplementation(async (id) => INTENT({ id, status: status[id] }));

    const out = await svc.sweepExpiredHolds();
    expect(out).toMatchObject({ enabled: true, scanned: 4, released: 2, reconciled_paid: 1, skipped: 1, errors: 0 });
    // A: canceled then released
    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_A', {}, { idempotencyKey: 'mo-cancel:pi_A' });
    expect(f.find(/UPDATE marketplace_orders SET payment_status = 'failed'/).map((c) => c.params[0])).toEqual(['oA']);
    // B (processing) and C (succeeded) are never canceled nor released
    expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);
    // C reconciles the sale instead (a lost success webhook)
    expect(f.find(/SET payment_status = 'paid'/).map((c) => c.params[0])).toEqual(['oC']);
    // D (no order) released by expiry-guarded UPDATE
    expect(f.has(/pending_expires_at < now\(\)/)).toBe(true);
  });

  test('an intent that succeeds during cancel is NOT released', async () => {
    const o = ORDER();
    const f = install([
      [/SELECT id, payment_status, stripe_payment_intent_id FROM marketplace_orders WHERE id = \$1/, { rows: [o] }],
    ]);
    mockStripe.paymentIntents.retrieve
      .mockResolvedValueOnce(INTENT({ status: 'requires_payment_method' }))
      .mockResolvedValueOnce(INTENT({ status: 'succeeded' }));
    mockStripe.paymentIntents.cancel.mockRejectedValueOnce(new Error('unexpected state'));
    const released = await svc.releaseOrder('o1', 'hold_expired', { cancelIntent: true });
    expect(released).toBe(false);
    expect(f.has(/SET payment_status = 'failed'/)).toBe(false);
  });
});

// ── 3. payment_failed never releases ────────────────────────────────────────────────────────────────
describe('handleIntentEvent', () => {
  test('payment_failed does NOT release the item (the same intent can still succeed)', async () => {
    const f = install([]);
    await svc.handleIntentEvent('payment_intent.payment_failed', INTENT({ status: 'requires_payment_method' }));
    expect(f.calls.length).toBe(0);
  });
  test('canceled releases the hold', async () => {
    const f = install([
      [/SELECT id FROM marketplace_orders WHERE stripe_payment_intent_id/, { rows: [{ id: 'o1' }] }],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 FOR UPDATE/, { rows: [ORDER()] }],
    ]);
    await svc.handleIntentEvent('payment_intent.canceled', INTENT({ status: 'canceled' }));
    expect(f.has(/SET payment_status = 'failed'/)).toBe(true);
    expect(f.has(/UPDATE marketplace_items SET status = 'active'/)).toBe(true);
  });
});

// ── 4. Public config route; others keep auth ────────────────────────────────────────────────────────
describe('/api/marketplace routes auth', () => {
  const express = require('express');
  const router = require('../src/routes/marketplaceOrders');
  let server; let base;
  beforeAll((done) => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = express(); app.use(express.json()); app.use('/api/marketplace', router);
    server = app.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; done(); });
  });
  afterAll((done) => { server.close(done); });

  test('GET /config works without login and exposes only flag + publishable key', async () => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy';
    const r = await fetch(base + '/api/marketplace/config');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ success: true, data: { checkout_enabled: true, stripe_publishable_key: 'pk_test_dummy' } });
  });
  test.each([
    ['post', '/orders/quote'], ['post', '/orders'], ['post', '/orders/o1/pay'], ['get', '/orders/mine'],
    ['get', '/seller/orders'], ['get', '/admin/orders'], ['post', '/admin/orders/o1/refund'],
  ])('%s %s still requires login', async (method, p) => {
    const r = await fetch(base + '/api/marketplace' + p, { method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' }, body: method === 'post' ? '{}' : undefined });
    expect(r.status).toBe(401);
  });
});

// ── 5. Quote gating ─────────────────────────────────────────────────────────────────────────────────
test('quote is refused (and never calls tax) when checkout is disabled', async () => {
  process.env.MARKETPLACE_CHECKOUT_ENABLED = 'false';
  install([]);
  await expect(svc.quote('item-1', 'buyer-1', {})).rejects.toMatchObject({ code: 'CHECKOUT_DISABLED' });
  expect(tax.computeTax).not.toHaveBeenCalled();
});

// ── 6. Tax: unique reversal refs, partial/outside refunds, jurisdiction ─────────────────────────────
describe('refund tax reversal', () => {
  test('full admin refund reverses with a UNIQUE reference (distinct from the sale reference)', async () => {
    const o = ORDER({ payment_status: 'paid', stripe_tax_transaction_id: 'tx_1' });
    install([
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 FOR UPDATE/, { rows: [o] }],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1/, { rows: [o] }],
      [/UPDATE marketplace_orders SET payment_status = 'refunded'/, { rows: [{ ...o, payment_status: 'refunded', refund_status: 'refunded' }] }],
    ]);
    await svc.refundOrder('o1', { adminId: 'admin-1' });
    expect(mockStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1', amount: 11000 }, { idempotencyKey: 'mo-refund:o1' });
    const ref = tax.reverseFullTransaction.mock.calls[0][0].reference;
    expect(ref).toBe('marketplace-refund:MO-001001');
    expect(ref).not.toBe('marketplace-order:MO-001001');
  });

  test('partial refund made outside the app → recorded + proportional tax reversal with unique refs', async () => {
    let o = ORDER({ payment_status: 'paid', stripe_tax_transaction_id: 'tx_1' });
    const f = install([
      [/FROM marketplace_orders WHERE stripe_payment_intent_id = \$1/, () => ({ rows: [o] })],
      [/SET refund_status = 'partially_refunded'/, (p) => { o = { ...o, refund_status: 'partially_refunded', refunded_amount_cents: p[1] }; return { rows: [o] }; }],
    ]);
    const handled = await svc.tryHandleChargeRefunded({ payment_intent: 'pi_1', amount: 11000, amount_refunded: 5000, refunded: false });
    expect(handled).toBe(true);
    expect(tax.reversePartialTransaction).toHaveBeenLastCalledWith({ originalTransactionId: 'tx_1',
      reference: 'marketplace-refund:MO-001001:5000', amountCents: 5000 });
    expect(f.find(/SET refund_status = 'partially_refunded'/)[0].params[1]).toBe(5000);
    // A second partial refund reverses only the new amount, under a new unique reference.
    await svc.tryHandleChargeRefunded({ payment_intent: 'pi_1', amount: 11000, amount_refunded: 8000, refunded: false });
    expect(tax.reversePartialTransaction).toHaveBeenLastCalledWith({ originalTransactionId: 'tx_1',
      reference: 'marketplace-refund:MO-001001:8000', amountCents: 3000 });
    expect(tax.reverseFullTransaction).not.toHaveBeenCalled();
  });

  test('outside full refund → refunded state + full reversal; replay is a no-op', async () => {
    let o = ORDER({ payment_status: 'paid', stripe_tax_transaction_id: 'tx_1' });
    install([
      [/FROM marketplace_orders WHERE stripe_payment_intent_id = \$1/, () => ({ rows: [o] })],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 FOR UPDATE/, () => ({ rows: [o] })],
      [/UPDATE marketplace_orders SET payment_status = 'refunded'/, () => { o = { ...o, payment_status: 'refunded', refund_status: 'refunded' }; return { rows: [o] }; }],
    ]);
    await svc.tryHandleChargeRefunded({ payment_intent: 'pi_1', amount: 11000, amount_refunded: 11000, refunded: true });
    expect(tax.reverseFullTransaction).toHaveBeenCalledWith({ originalTransactionId: 'tx_1', reference: 'marketplace-refund:MO-001001' });
    await svc.tryHandleChargeRefunded({ payment_intent: 'pi_1', amount: 11000, amount_refunded: 11000, refunded: true });
    expect(tax.reverseFullTransaction).toHaveBeenCalledTimes(1);
  });

  test('a failing tax reversal never crashes the refund — the order is flagged for review', async () => {
    const o = ORDER({ payment_status: 'paid', stripe_tax_transaction_id: 'tx_1' });
    const f = install([
      [/FROM marketplace_orders WHERE stripe_payment_intent_id = \$1/, { rows: [o] }],
      [/SET refund_status = 'partially_refunded'/, { rows: [{ ...o, refund_status: 'partially_refunded' }] }],
    ]);
    tax.reversePartialTransaction.mockRejectedValueOnce(new Error('tax api down'));
    await expect(svc.tryHandleChargeRefunded({ payment_intent: 'pi_1', amount: 11000, amount_refunded: 2000 })).resolves.toBe(true);
    expect(f.find(/SET refund_status = 'partially_refunded'/)[0].params[4]).toMatch(/review required/i);
  });

  test('taxCalculationService.reversePartialTransaction sends a negative flat amount in partial mode', async () => {
    const real = jest.requireActual('../src/services/taxCalculationService');
    process.env.STRIPE_TAX_ENABLED = 'true';
    try {
      await real.reversePartialTransaction({ originalTransactionId: 'tx_1', reference: 'marketplace-refund:MO-1:5000', amountCents: 5000 });
      expect(mockStripe.tax.transactions.createReversal).toHaveBeenCalledWith(
        { mode: 'partial', original_transaction: 'tx_1', reference: 'marketplace-refund:MO-1:5000', flat_amount: -5000 },
        { idempotencyKey: 'taxrev:marketplace-refund:MO-1:5000' });
    } finally { delete process.env.STRIPE_TAX_ENABLED; }
  });
});

describe('tax jurisdiction (sale location, owner rule 2026-09-28)', () => {
  const ship = { name: 'B', line1: '1 Main St', city: 'Austin', state: 'tx', postal_code: '78701', country: 'US' };
  // The item's own pickup location (Houston). Never the seller's legal address.
  const PICKUP = { pickup_address_line1: '9 Dock Rd', pickup_city: 'Houston', pickup_state: 'TX', pickup_postal_code: '77002', pickup_country: 'US' };
  test('tax OFF → no location needed', async () => {
    install([]);
    await expect(svc.resolveTaxLocation({ method: 'pickup', item: { id: 'i', seller_id: 's' } })).resolves.toBeNull();
  });
  test('shipping → destination is the order ship-to; origin is the item pickup location', async () => {
    tax.taxEnabled.mockImplementation(() => true);
    install([]);
    const l = await svc.resolveTaxLocation({ method: 'shipping', item: { id: 'i', ...PICKUP }, shipTo: JSON.stringify(ship) });
    expect(l.address).toMatchObject({ line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701' });
    expect(l.shipFrom).toMatchObject({ line1: '9 Dock Rd', state: 'TX', postal_code: '77002' });
  });
  test('pickup → the item pickup location (customer address and origin), never the seller legal address', async () => {
    tax.taxEnabled.mockImplementation(() => true);
    install([]);
    const l = await svc.resolveTaxLocation({ method: 'pickup', item: { id: 'i', seller_id: 's', ...PICKUP } });
    expect(l.address).toMatchObject({ line1: '9 Dock Rd', postal_code: '77002' });
    expect(l.shipFrom).toEqual(l.address);
    expect(db.query.mock.calls.some(([sql]) => /seller_identity/.test(sql))).toBe(false);
  });
  test('an item without a pickup location is refused (named parts), not taxed somewhere else', async () => {
    tax.taxEnabled.mockImplementation(() => true);
    install([]);
    await expect(svc.resolveTaxLocation({ method: 'pickup', item: { id: 'i', seller_id: 's', pickup_city: 'Houston', pickup_state: 'TX' } }))
      .rejects.toMatchObject({ code: 'PICKUP_LOCATION_MISSING', missing: ['street address', 'ZIP code'] });
    await expect(svc.resolveTaxLocation({ method: 'shipping', item: { id: 'i', seller_id: 's' }, shipTo: JSON.stringify(ship) }))
      .rejects.toMatchObject({ code: 'PICKUP_LOCATION_MISSING' });
  });
  test('createOrder (shipping) taxes the stored ship-to with the item origin, ignoring a different request-body address', async () => {
    tax.taxEnabled.mockImplementation(() => true);
    tax.computeTax.mockImplementation(async () => ({ enabled: true, taxCents: 825, calculationId: 'calc_1', exempt: false }));
    const itemRow = { id: 'item-1', seller_id: 'seller-1', seller_user_id: 'su', seller_type: 'estate_sale_company',
      price_cents: 10000, status: 'active', shippable: true, shipping_cost_cents: 1000, ...PICKUP };
    install([
      [/JOIN seller_profiles sp ON sp.id = mi.seller_id/, { rows: [itemRow] }],
      [/SELECT \* FROM marketplace_items WHERE id = \$1 FOR UPDATE/, { rows: [itemRow] }],
      [/INSERT INTO marketplace_orders/, (p) => ({ rows: [ORDER({ fulfillment_method: 'shipping', ship_to: JSON.parse(p[10]) })] })],
      [/UPDATE marketplace_orders SET stripe_payment_intent_id/, (p) => ({ rows: [ORDER({ tax_cents: p[3], total_charge_cents: p[4] })] })],
    ]);
    await svc.createOrder('item-1', 'buyer-1', { fulfillment_method: 'shipping', ship_to: ship,
      address: { line1: '5 Elsewhere', city: 'Portland', state: 'OR', postal_code: '97201', country: 'US' } });
    const call = tax.computeTax.mock.calls[0][0];
    expect(call.address).toMatchObject({ line1: '1 Main St', state: 'TX', postal_code: '78701' });
    expect(call.shipFrom).toMatchObject({ line1: '9 Dock Rd', postal_code: '77002' });
    expect(call.addressSource).toBe('shipping');
    const pi = mockStripe.paymentIntents.create.mock.calls[0][0];
    expect(pi.amount).toBe(10000 + 1000 + 825);
    expect(pi.confirmation_method).toBe('manual'); // the browser cannot confirm with an unchecked card
    expect(pi.payment_method_types).toEqual(['card']);
  });
});

// ── 7. Prepaid refusal at storefront checkout (server-confirmed) ────────────────────────────────────
describe('payOrder: card funding check before any charge', () => {
  function payRoutes() {
    return install([
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 AND buyer_user_id = \$2/, { rows: [ORDER()] }],
      [/UPDATE marketplace_items SET pending_expires_at = GREATEST/, { rowCount: 1, rows: [] }],
      [/SELECT stripe_customer_id FROM users/, { rows: [{ stripe_customer_id: 'cus_1' }] }],
      [/FROM marketplace_orders WHERE stripe_payment_intent_id = \$1 FOR UPDATE/, { rows: [ORDER()] }],
      [/FROM marketplace_items WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'item-1', status: 'pending_purchase', pending_order_id: 'o1' }] }],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1/, { rows: [ORDER({ payment_status: 'paid' })] }],
    ]);
  }
  const pm = (funding) => ({ id: 'pm_' + funding, type: 'card', customer: null, card: { brand: 'visa', last4: '4242', funding } });

  test('prepaid → 422 with the platform message; the intent is never confirmed', async () => {
    payRoutes();
    mockStripe.paymentMethods.retrieve.mockResolvedValueOnce(pm('prepaid'));
    await expect(svc.payOrder('o1', 'buyer-1', { paymentMethodId: 'pm_prepaid' }))
      .rejects.toMatchObject({ status: 422, code: 'PREPAID_NOT_ACCEPTED', message: PREPAID_MESSAGE });
    expect(mockStripe.paymentIntents.confirm).not.toHaveBeenCalled();
    expect(PREPAID_MESSAGE).not.toMatch(/stripe/i);
  });

  test.each(['credit', 'debit', 'unknown'])('%s card → confirmed server-side and paid', async (funding) => {
    const f = payRoutes();
    mockStripe.paymentMethods.retrieve.mockResolvedValueOnce(pm(funding));
    mockStripe.paymentIntents.confirm.mockResolvedValueOnce(INTENT({ status: 'succeeded' }));
    const out = await svc.payOrder('o1', 'buyer-1', { paymentMethodId: 'pm_' + funding, idempotencyKey: 'k1' });
    expect(mockStripe.paymentIntents.confirm).toHaveBeenCalledWith('pi_1', { payment_method: 'pm_' + funding }, { idempotencyKey: 'mo-confirm:o1:k1' });
    expect(out.status).toBe('succeeded');
    expect(f.has(/SET payment_status = 'paid'/)).toBe(true);
  });

  test('3-D Secure → requires_action + client_secret, then server finalizes', async () => {
    payRoutes();
    mockStripe.paymentMethods.retrieve.mockResolvedValueOnce(pm('credit'));
    mockStripe.paymentIntents.confirm.mockResolvedValueOnce(INTENT({ status: 'requires_action', client_secret: 'cs_1' }));
    const step1 = await svc.payOrder('o1', 'buyer-1', { paymentMethodId: 'pm_credit' });
    expect(step1).toMatchObject({ status: 'requires_action', client_secret: 'cs_1' });
    mockStripe.paymentIntents.retrieve.mockResolvedValueOnce(INTENT({ status: 'requires_confirmation', payment_method: pm('credit') }));
    mockStripe.paymentIntents.confirm.mockResolvedValueOnce(INTENT({ status: 'succeeded' }));
    const step2 = await svc.payOrder('o1', 'buyer-1', {});
    expect(step2.status).toBe('succeeded');
    expect(mockStripe.paymentIntents.confirm).toHaveBeenLastCalledWith('pi_1', {}, undefined);
  });

  test('declined card → 402 with neutral wording; the order stays payable for a retry', async () => {
    const f = payRoutes();
    mockStripe.paymentMethods.retrieve.mockResolvedValueOnce(pm('credit'));
    mockStripe.paymentIntents.confirm.mockRejectedValueOnce(Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined' }));
    const e = await svc.payOrder('o1', 'buyer-1', { paymentMethodId: 'pm_credit' }).catch((x) => x);
    expect(e).toMatchObject({ status: 402, code: 'CARD_DECLINED' });
    expect(e.message).not.toMatch(/stripe/i);
    expect(f.has(/SET payment_status = 'failed'/)).toBe(false);
  });

  test('an expired hold cannot be paid', async () => {
    install([
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 AND buyer_user_id = \$2/, { rows: [ORDER()] }],
      [/UPDATE marketplace_items SET pending_expires_at = GREATEST/, { rowCount: 0, rows: [] }],
    ]);
    await expect(svc.payOrder('o1', 'buyer-1', { paymentMethodId: 'pm_x' })).rejects.toMatchObject({ code: 'ORDER_NOT_PAYABLE' });
    expect(mockStripe.paymentMethods.retrieve).not.toHaveBeenCalled();
  });
});

// ── "Try again" reuses the same order/intent ────────────────────────────────────────────────────────
test('createOrder by the same buyer while their hold is live returns the SAME order (no second order/intent)', async () => {
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const f = install([
    [/JOIN seller_profiles sp ON sp.id = mi.seller_id/, { rows: [{ id: 'item-1', seller_id: 'seller-1', seller_user_id: 'su',
      seller_type: 'estate_sale_company', price_cents: 10000, status: 'pending_purchase', pending_order_id: 'o1', pending_expires_at: future, shippable: false }] }],
    [/SELECT \* FROM marketplace_orders WHERE id = \$1/, { rows: [ORDER({ shipping_cents: 0, ship_to: null })] }],
  ]);
  mockStripe.paymentIntents.retrieve.mockResolvedValueOnce(INTENT({ status: 'requires_payment_method', client_secret: 'cs_1' }));
  const out = await svc.createOrder('item-1', 'buyer-1', { fulfillment_method: 'pickup' });
  expect(out.reused).toBe(true);
  expect(out.order.id).toBe('o1');
  expect(out.client_secret).toBe('cs_1');
  expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
  expect(f.has(/INSERT INTO marketplace_orders/)).toBe(false);
});

// ── 9. Fee base ─────────────────────────────────────────────────────────────────────────────────────
test('11% storefront fee is on the ITEM PRICE only — shipping and sales tax excluded', () => {
  const b = svc.computeBreakdown({ itemPriceCents: 20000, shippingCents: 2500, taxCents: 1856, feeBps: svc.feeBpsForSeller({ platform_fee_bps: 400 }) });
  expect(b.platform_fee_cents).toBe(2200);                    // 11% of $200, not of $243.56
  expect(b.seller_proceeds_cents).toBe(20000 + 2500 - 2200);  // item + shipping − fee (tax never proceeds)
  expect(b.total_charge_cents).toBe(20000 + 2500 + 1856);
  const noShipNoTax = svc.computeBreakdown({ itemPriceCents: 20000, shippingCents: 0, taxCents: 0, feeBps: 1100 });
  expect(noShipNoTax.platform_fee_cents).toBe(b.platform_fee_cents);
});
