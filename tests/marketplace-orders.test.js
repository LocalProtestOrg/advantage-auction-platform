'use strict';

/**
 * Fixed-price Marketplace Buy Now — order service.
 * Money rules (owner-decided): platform fee = seller platform_fee_bps of ITEM PRICE only; seller proceeds
 * = item + shipping − fee; sales tax EXCLUDED from proceeds; buyer total = item + shipping + tax. Plus the
 * fulfillment state machine → payout eligibility, the one-of-one concurrency guard, and relist rules.
 */

let mockClient = null;
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/utils/withTransaction', () => ({ withTransaction: (fn) => fn(mockClient) }));
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn() }));
jest.mock('../src/services/marketplaceOrderNotifier', () => ({ sendPaid: jest.fn(), sendRefunded: jest.fn() }));
jest.mock('../src/services/taxCalculationService', () => ({
  computeTax: jest.fn(async () => ({ enabled: false, taxCents: 0, calculationId: null, exempt: false })),
  recordTransaction: jest.fn(async () => null),
  reverseFullTransaction: jest.fn(async () => null),
}));
const mockStripe = {
  paymentIntents: { create: jest.fn(async () => ({ id: 'pi_test_1', client_secret: 'cs_test_1' })) },
  refunds: { create: jest.fn(async () => ({ id: 're_1' })) },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

const db = require('../src/db');
const svc = require('../src/services/marketplaceOrderService');

function makeClient(routes, rec) {
  return { query: async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim(); if (rec) rec.push({ sql: flat, params });
    for (const [re, res] of routes) if (re.test(flat)) return typeof res === 'function' ? res(params) : res;
    return { rows: [], rowCount: 0 };
  } };
}
beforeEach(() => {
  db.query.mockReset();
  process.env.MARKETPLACE_CHECKOUT_ENABLED = 'true';
  mockStripe.paymentIntents.create.mockClear();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
});

// ── Money math ─────────────────────────────────────────────────────────────────────────────────────────
describe('platform fee + seller proceeds (owner rules)', () => {
  test('storefront selling fee is a FLAT 11%, DECOUPLED from the auction platform_fee_bps column', () => {
    expect(svc.STOREFRONT_FEE_BPS).toBe(1100);
    // Flat: ignores any per-seller auction platform_fee_bps (that column stays an auction-only input).
    expect(svc.feeBpsForSeller({ platform_fee_bps: 400 })).toBe(1100);
    expect(svc.feeBpsForSeller({ platform_fee_bps: 250 })).toBe(1100);
    expect(svc.feeBpsForSeller({})).toBe(1100);
  });

  test('$1000 item @ 4% → fee $40; @ 3% → $30 (fee is on ITEM PRICE only)', () => {
    const at4 = svc.computeBreakdown({ itemPriceCents: 100000, shippingCents: 0, taxCents: 0, feeBps: 400 });
    expect(at4.platform_fee_cents).toBe(4000);
    const at3 = svc.computeBreakdown({ itemPriceCents: 100000, shippingCents: 0, taxCents: 0, feeBps: 300 });
    expect(at3.platform_fee_cents).toBe(3000);
  });

  test('shipping is NOT in the fee base; seller keeps shipping; tax EXCLUDED from proceeds', () => {
    // $1000 item + $50 shipping + $82.50 tax @ 4%
    const b = svc.computeBreakdown({ itemPriceCents: 100000, shippingCents: 5000, taxCents: 8250, feeBps: 400 });
    expect(b.platform_fee_cents).toBe(4000);                 // 4% of item only (not shipping, not tax)
    expect(b.seller_proceeds_cents).toBe(100000 + 5000 - 4000); // item + shipping − fee = $1010
    expect(b.total_charge_cents).toBe(100000 + 5000 + 8250);    // buyer pays item + shipping + tax
    // tax never touches proceeds:
    const noTax = svc.computeBreakdown({ itemPriceCents: 100000, shippingCents: 5000, taxCents: 0, feeBps: 400 });
    expect(noTax.seller_proceeds_cents).toBe(b.seller_proceeds_cents);
  });

  test('platform fee is not a buyer-facing charge (total excludes fee)', () => {
    const b = svc.computeBreakdown({ itemPriceCents: 50000, shippingCents: 0, taxCents: 0, feeBps: 400 });
    expect(b.total_charge_cents).toBe(50000); // buyer pays exactly item (+shipping+tax); fee is seller-side
  });
});

// ── Owner-authoritative FLAT 11% storefront selling fee (cases A–K) ──────────────────────────────────
describe('flat 11% storefront selling fee', () => {
  const billingTerms = require('../src/services/billingTermsService');
  // A NEW order uses the flat rate from feeBpsForSeller (11%); computeBreakdown then applies it.
  const newOrder = (item, ship = 0, tax = 0) =>
    svc.computeBreakdown({ itemPriceCents: item, shippingCents: ship, taxCents: tax, feeBps: svc.feeBpsForSeller({}) });

  test('A. $100.00 item → selling fee $11.00', () => {
    expect(newOrder(10000).platform_fee_cents).toBe(1100);
  });
  test('B. $1,000.00 item → selling fee $110.00', () => {
    expect(newOrder(100000).platform_fee_cents).toBe(11000);
  });
  test('C. $1,000 item + $75 shipping → fee stays $110 (shipping excluded from base)', () => {
    const b = newOrder(100000, 7500);
    expect(b.platform_fee_cents).toBe(11000);
    expect(b.seller_proceeds_cents).toBe(100000 + 7500 - 11000); // item + shipping − 11% = $965
  });
  test('D. sales tax does NOT increase the 11% fee', () => {
    const b = newOrder(100000, 0, 8250);
    expect(b.platform_fee_cents).toBe(11000);          // unchanged by tax
    expect(b.total_charge_cents).toBe(100000 + 8250);  // buyer pays item + tax
  });
  test('E. seller proceeds = item + shipping − 11% (tax never in proceeds)', () => {
    const b = newOrder(100000, 7500, 8250);
    expect(b.seller_proceeds_cents).toBe(96500);       // 1000 + 75 − 110
  });
  test('F. NO double processing deduction — fee is exactly 11%, not 11% + 3%', () => {
    const b = newOrder(100000);
    expect(b.platform_fee_cents).toBe(11000);          // not 14000, not 11000+3000
    expect(b.seller_proceeds_cents).toBe(89000);       // exactly item − 11%
  });
  test('G. a HISTORICAL order (its own snapshot bps) is NOT recalculated to 11%', () => {
    // computeBreakdown honors the bps passed in — a replay of an old 4% order still computes 4%.
    expect(svc.computeBreakdown({ itemPriceCents: 100000, shippingCents: 0, taxCents: 0, feeBps: 400 }).platform_fee_cents).toBe(4000);
  });
  test('I/K. AUCTION economics unchanged — decoupled from the storefront fee', () => {
    // The auction professional fee constant + the per-seller auction column are untouched.
    expect(billingTerms.DEFAULT_PRO_PLATFORM_FEE_BPS).toBe(400);
    // Auction settlement still reads the seller's platform_fee_bps (e.g. a negotiated 250 stays 250)…
    const s = billingTerms.settlement({ sellerType: 'auction_house', hammerCents: 100000, buyerPremiumCents: 18000, platformFeeBps: 250 });
    expect(s.platform_fee_bps).toBe(250);
    expect(s.platform_fee_cents).toBe(2500); // 2.5% of hammer — auction math intact
    // …while the STOREFRONT fee ignores that column entirely (flat 11%).
    expect(svc.feeBpsForSeller({ platform_fee_bps: 250 })).toBe(1100);
  });
  test('J. Individual seller auction economics unchanged (no platform fee)', () => {
    const s = billingTerms.settlement({ sellerType: 'private', hammerCents: 100000, buyerPremiumCents: 18000, platformFeeBps: 0 });
    expect(s.platform_fee_cents).toBe(0);
  });
  test('internal allocation is reporting-only (8% + 3% = the flat 11%)', () => {
    expect(svc.STOREFRONT_FEE_ADVANTAGE_BPS + svc.STOREFRONT_FEE_PROCESSING_BPS).toBe(svc.STOREFRONT_FEE_BPS);
  });
});

// ── Purchase eligibility guards ──────────────────────────────────────────────────────────────────────
describe('loadItemForPurchase guards', () => {
  const PRO_ITEM = (over = {}) => ({ rows: [{
    id: 'item-1', seller_id: 'seller-1', seller_user_id: 'seller-user', seller_type: 'estate_sale_company',
    platform_fee_bps: 400, price_cents: 100000, status: 'active', shippable: true, shipping_cost_cents: 5000, is_demo: false, ...over }] });

  test('rejects buying your own listing', async () => {
    db.query.mockImplementation(async () => PRO_ITEM());
    await expect(svc.loadItemForPurchase('item-1', 'seller-user', 'pickup')).rejects.toMatchObject({ code: 'CANNOT_BUY_OWN' });
  });
  test('rejects shipping when item is pickup-only', async () => {
    db.query.mockImplementation(async () => PRO_ITEM({ shippable: false }));
    await expect(svc.loadItemForPurchase('item-1', 'buyer-1', 'shipping')).rejects.toMatchObject({ code: 'SHIPPING_UNAVAILABLE' });
  });
  test('rejects a non-professional seller item', async () => {
    db.query.mockImplementation(async () => PRO_ITEM({ seller_type: 'private' }));
    await expect(svc.loadItemForPurchase('item-1', 'buyer-1', 'pickup')).rejects.toMatchObject({ code: 'NOT_PROFESSIONAL' });
  });
  test('shipping cost applies only for shipping method', async () => {
    db.query.mockImplementation(async () => PRO_ITEM());
    const pickup = await svc.loadItemForPurchase('item-1', 'buyer-1', 'pickup');
    expect(pickup.shippingCents).toBe(0);
    const ship = await svc.loadItemForPurchase('item-1', 'buyer-1', 'shipping');
    expect(ship.shippingCents).toBe(5000);
  });
});

// ── Concurrency: one-of-one item cannot be double-claimed ────────────────────────────────────────────
describe('createOrder concurrency guard', () => {
  test('refuses when the item is already sold', async () => {
    // loadItemForPurchase (pre-lock) passes, but the FOR UPDATE row shows sold → NOT_AVAILABLE.
    db.query.mockImplementation(async (sql) => {
      if (/JOIN seller_profiles sp/.test(sql)) return { rows: [{ id: 'item-1', seller_id: 'seller-1', seller_user_id: 'su', seller_type: 'estate_sale_company', platform_fee_bps: 400, price_cents: 100000, status: 'active', shippable: false, shipping_cost_cents: null }] };
      return { rows: [] };
    });
    mockClient = makeClient([[/SELECT \* FROM marketplace_items WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'item-1', status: 'sold', price_cents: 100000 }] }]]);
    await expect(svc.createOrder('item-1', 'buyer-1', { fulfillment_method: 'pickup' })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled(); // no charge attempted
  });

  test('refuses checkout entirely when the flag is OFF', async () => {
    process.env.MARKETPLACE_CHECKOUT_ENABLED = 'false';
    db.query.mockImplementation(async () => ({ rows: [{ id: 'item-1', seller_id: 's', seller_user_id: 'su', seller_type: 'estate_sale_company', platform_fee_bps: 400, price_cents: 100000, status: 'active', shippable: false }] }));
    await expect(svc.createOrder('item-1', 'buyer-1', { fulfillment_method: 'pickup' })).rejects.toMatchObject({ code: 'CHECKOUT_DISABLED' });
  });
});

// ── Fulfillment state machine → payout eligibility (never moves money) ────────────────────────────────
describe('updateFulfillment', () => {
  const seller = { rows: [{ id: 'seller-1' }] };
  const order = (over = {}) => ({ id: 'order-1', seller_id: 'seller-1', payment_status: 'paid',
    fulfillment_method: 'pickup', fulfillment_status: 'unfulfilled', payout_eligible: false, ...over });

  function routesFor(o) {
    let updated = null;
    const routes = [
      [/FROM seller_profiles WHERE user_id/, seller],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 FOR UPDATE/, { rows: [o] }],
      [/UPDATE marketplace_orders SET fulfillment_status/, (p) => { updated = { fulfillment_status: p[1], payout_eligible: p[4] ? true : o.payout_eligible, tracking_carrier: p[2], tracking_number: p[3] }; return { rows: [{ ...o, ...updated }] }; }],
    ];
    return { routes, get: () => updated };
  }

  test('pickup: picked_up marks payout ELIGIBLE', async () => {
    const r = routesFor(order({ fulfillment_status: 'ready_for_pickup' }));
    mockClient = makeClient(r.routes);
    const out = await svc.updateFulfillment('order-1', 'seller-user', 'picked_up');
    expect(out.fulfillment_status).toBe('picked_up');
    expect(out.payout_eligible).toBe(true);
  });

  test('pickup: ready_for_pickup does NOT make payout eligible yet', async () => {
    const r = routesFor(order());
    mockClient = makeClient(r.routes);
    const out = await svc.updateFulfillment('order-1', 'seller-user', 'ready_for_pickup');
    expect(out.fulfillment_status).toBe('ready_for_pickup');
    expect(out.payout_eligible).toBe(false);
  });

  test('shipping: complete (after shipped) makes payout eligible', async () => {
    const r = routesFor(order({ fulfillment_method: 'shipping', fulfillment_status: 'shipped' }));
    mockClient = makeClient(r.routes);
    const out = await svc.updateFulfillment('order-1', 'seller-user', 'complete');
    expect(out.fulfillment_status).toBe('completed');
    expect(out.payout_eligible).toBe(true);
  });

  test('rejects a pickup action on a shipping order', async () => {
    mockClient = makeClient([[/FROM seller_profiles WHERE user_id/, seller],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 FOR UPDATE/, { rows: [order({ fulfillment_method: 'shipping' })] }]]);
    await expect(svc.updateFulfillment('order-1', 'seller-user', 'ready_for_pickup')).rejects.toMatchObject({ code: 'WRONG_METHOD' });
  });

  test('rejects a seller acting on an order that is not theirs', async () => {
    mockClient = makeClient([[/FROM seller_profiles WHERE user_id/, seller],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 FOR UPDATE/, { rows: [order({ seller_id: 'other-seller' })] }]]);
    await expect(svc.updateFulfillment('order-1', 'seller-user', 'picked_up')).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });

  test('rejects an out-of-order transition', async () => {
    mockClient = makeClient([[/FROM seller_profiles WHERE user_id/, seller],
      [/SELECT \* FROM marketplace_orders WHERE id = \$1 FOR UPDATE/, { rows: [order({ fulfillment_method: 'shipping', fulfillment_status: 'unfulfilled' })] }]]);
    await expect(svc.updateFulfillment('order-1', 'seller-user', 'complete')).rejects.toMatchObject({ code: 'BAD_TRANSITION' });
  });
});

// ── Relist rules ─────────────────────────────────────────────────────────────────────────────────────
describe('relistItem', () => {
  const seller = { rows: [{ id: 'seller-1' }] };
  test('a removed (refunded) item can be relisted', async () => {
    mockClient = makeClient([
      [/FROM seller_profiles WHERE user_id/, seller],
      [/SELECT \* FROM marketplace_items WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'item-1', seller_id: 'seller-1', status: 'removed' }] }],
      [/UPDATE marketplace_items SET status = 'active'/, { rows: [{ id: 'item-1', status: 'active' }] }],
    ]);
    const out = await svc.relistItem('item-1', 'seller-user');
    expect(out.status).toBe('active');
  });
  test('an active item is NOT relistable', async () => {
    mockClient = makeClient([
      [/FROM seller_profiles WHERE user_id/, seller],
      [/SELECT \* FROM marketplace_items WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'item-1', seller_id: 'seller-1', status: 'active' }] }],
    ]);
    await expect(svc.relistItem('item-1', 'seller-user')).rejects.toMatchObject({ code: 'NOT_RELISTABLE' });
  });
  test('cannot relist another seller\'s item', async () => {
    mockClient = makeClient([
      [/FROM seller_profiles WHERE user_id/, seller],
      [/SELECT \* FROM marketplace_items WHERE id = \$1 FOR UPDATE/, { rows: [{ id: 'item-1', seller_id: 'other', status: 'removed' }] }],
    ]);
    await expect(svc.relistItem('item-1', 'seller-user')).rejects.toMatchObject({ code: 'NOT_OWNER' });
  });
});

// ── publicOrder shaping ──────────────────────────────────────────────────────────────────────────────
test('publicOrder exposes money snapshot + never crashes on null', () => {
  expect(svc.publicOrder(null)).toBeNull();
  const o = svc.publicOrder({ id: 'o1', order_number: 'MO-001001', item_price_cents: 100000, shipping_cents: 5000,
    tax_cents: 0, platform_fee_bps: 400, platform_fee_cents: 4000, seller_proceeds_cents: 101000,
    total_charge_cents: 105000, fulfillment_method: 'shipping', fulfillment_status: 'unfulfilled',
    payment_status: 'paid', refund_status: 'none', payout_eligible: false });
  expect(o.order_number).toBe('MO-001001');
  expect(o.seller_proceeds_cents).toBe(101000);
  expect(o.total_charge_cents).toBe(105000);
});
