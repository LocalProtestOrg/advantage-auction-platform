'use strict';

/**
 * Sale location for sales tax (owner rule, 2026-09-28). Sellers and buyers are in different states; the tax location is
 * where the SALE happens, never the buyer's billing address, the seller's legal address or Advantage.Bid's own address.
 *
 *   Auction (pickup)                → the auction's pickup address
 *   Storefront item from a lot      → the originating auction's pickup address (unless the seller changes it)
 *   Independent storefront item     → the pickup location the seller entered
 *   Shipped storefront order        → origin = item pickup location; destination = buyer ship-to
 *   Missing location                → blocked, with the missing parts named; seller/admin told
 *
 * These tests run the REAL taxCalculationService against a mocked provider and assert the exact addresses sent.
 */

process.env.STRIPE_SECRET_KEY = 'sk_test_unit_only';
process.env.STRIPE_TAX_ENABLED = 'true';

const mockCalcCreate = jest.fn(async () => ({ id: 'taxcalc_1', tax_amount_exclusive: 625 }));
jest.mock('stripe', () => jest.fn(() => ({ tax: { calculations: { create: mockCalcCreate } } })));
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn(async () => {}) }));
jest.mock('../src/services/taxExemptionService', () => ({ effectiveExemptionForSale: jest.fn(async () => null) }));
jest.mock('../src/services/saleLocationAlerts', () => ({ reportMissingSaleLocation: jest.fn(async () => {}) }));

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const alerts = require('../src/services/saleLocationAlerts');
const saleLocation = require('../src/lib/saleLocation');
const paymentService = require('../src/services/paymentService');
const orders = require('../src/services/marketplaceOrderService');
const items = require('../src/services/marketplaceItemService');

// ── Fixtures: a Texas seller, buyers in Ohio and New York, a Colorado storefront ─────────────────────────
const AUCTION_TX = { auction_id: 'auc-tx', street_address: '100 Congress Ave', city: 'Austin', address_state: 'TX', zip: '78701' };
const BUYER_OH_BILLING = { tax_address_line1: '1 High St', tax_city: 'Columbus', tax_state: 'OH', tax_postal_code: '43215', tax_country: 'US' };
const ITEM_CO = { id: 'item-co', seller_id: 'seller-co', pickup_location_source: 'item', pickup_address_line1: '1600 Market St', pickup_city: 'Denver', pickup_state: 'CO',
  pickup_postal_code: '80202', pickup_country: 'US' };
const SHIP_TO_NY = { name: 'Buyer', line1: '350 5th Ave', city: 'New York', state: 'NY', postal_code: '10118', country: 'US' };
const ADVANTAGE_HQ = /Ogden|Adrian|49221/;   // Advantage.Bid's own address must never appear in a transaction

function sentToProvider() {
  expect(mockCalcCreate).toHaveBeenCalledTimes(1);
  return mockCalcCreate.mock.calls[0][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (/FROM payments p JOIN auctions a/.test(sql)) return { rows: [AUCTION_TX] };
    if (/FROM users/.test(sql)) return { rows: [BUYER_OH_BILLING] };   // present, and must NOT be used
    if (/UPDATE payments/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
});

describe('auction: a Texas pickup sold to an Ohio buyer is taxed in Texas', () => {
  test('the provider receives the auction pickup address as the place of sale and as the origin', async () => {
    const charge = await paymentService._applyTaxToPayment({ paymentId: 'pay-1', buyerUserId: 'buyer-oh', taxableBaseCents: 10000 });
    expect(charge).toBe(10625);
    const p = sentToProvider();
    expect(p.customer_details.address).toMatchObject({ line1: '100 Congress Ave', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' });
    expect(p.customer_details.address_source).toBe('shipping');
    expect(p.ship_from_details.address).toMatchObject({ state: 'TX', postal_code: '78701' });
    expect(JSON.stringify(p)).not.toMatch(/Columbus|OH|43215/);
    expect(JSON.stringify(p)).not.toMatch(ADVANTAGE_HQ);
    // The buyer's billing address is never even read for an auction sale.
    expect(db.query.mock.calls.some(([sql]) => /tax_address_line1/.test(sql))).toBe(false);
  });
  test('an auction without a complete pickup address is blocked; the admin is told what is missing; nothing is sent', async () => {
    db.query.mockImplementation(async (sql) => (/FROM payments p JOIN auctions a/.test(sql)
      ? { rows: [{ ...AUCTION_TX, street_address: '', zip: null }] } : { rows: [BUYER_OH_BILLING] }));
    await expect(paymentService._applyTaxToPayment({ paymentId: 'pay-1', buyerUserId: 'buyer-oh', taxableBaseCents: 10000 }))
      .rejects.toMatchObject({ code: 'PICKUP_LOCATION_MISSING', status: 409, missing: ['street address', 'ZIP code'] });
    expect(mockCalcCreate).not.toHaveBeenCalled();
    expect(alerts.reportMissingSaleLocation).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'auction', entityId: 'auc-tx' }));
  });
  test('an auction cannot be submitted or published without a complete pickup address', () => {
    const { assertPickupLocationComplete } = require('../src/services/auctionService');
    expect(() => assertPickupLocationComplete(AUCTION_TX)).not.toThrow();
    expect(() => assertPickupLocationComplete({ ...AUCTION_TX, street_address: null }))
      .toThrow(expect.objectContaining({ code: 'PICKUP_LOCATION_REQUIRED', status: 422 }));
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'auctionService.js'), 'utf8');
    expect((src.match(/assertPickupLocationComplete\(/g) || []).length).toBeGreaterThanOrEqual(3); // def + publish + submit
  });
});

describe('storefront: a Colorado seller selling to a New York buyer', () => {
  test('PICKUP: taxed at the Denver pickup location (the buyer takes possession in Colorado)', async () => {
    const loc = await orders.resolveTaxLocation({ method: 'pickup', item: ITEM_CO });
    await require('../src/services/taxCalculationService').computeTax({ buyerUserId: 'buyer-ny', taxableBaseCents: 20000,
      address: loc.address, shipFrom: loc.shipFrom, addressSource: 'shipping', reference: 't' });
    const p = sentToProvider();
    expect(p.customer_details.address).toMatchObject({ line1: '1600 Market St', city: 'Denver', state: 'CO', postal_code: '80202' });
    expect(p.customer_details.address_source).toBe('shipping');
    expect(p.ship_from_details.address).toMatchObject({ state: 'CO' });
    expect(JSON.stringify(p)).not.toMatch(/New York|NY|10118/);
    expect(JSON.stringify(p)).not.toMatch(ADVANTAGE_HQ);
  });
  test('SHIPPING: destination = the New York ship-to; origin = the Denver item location', async () => {
    const loc = await orders.resolveTaxLocation({ method: 'shipping', item: ITEM_CO, shipTo: JSON.stringify(SHIP_TO_NY) });
    await require('../src/services/taxCalculationService').computeTax({ buyerUserId: 'buyer-ny', taxableBaseCents: 20000,
      address: loc.address, shipFrom: loc.shipFrom, addressSource: 'shipping', reference: 't' });
    const p = sentToProvider();
    expect(p.customer_details.address).toMatchObject({ line1: '350 5th Ave', city: 'New York', state: 'NY', postal_code: '10118' });
    expect(p.ship_from_details.address).toMatchObject({ line1: '1600 Market St', state: 'CO', postal_code: '80202' });
    expect(JSON.stringify(p)).not.toMatch(ADVANTAGE_HQ);
  });
  test('the seller\'s legal/agreement address is never consulted for a storefront sale', async () => {
    await orders.resolveTaxLocation({ method: 'pickup', item: ITEM_CO });
    expect(db.query.mock.calls.some(([sql]) => /seller_identity/.test(sql))).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
    expect(src).not.toMatch(/FROM seller_identity/);
  });
  test('missing item location blocks the sale (buyer told plainly; seller/admin told what is missing)', async () => {
    await expect(orders.resolveTaxLocation({ method: 'shipping', item: { id: 'item-x', seller_id: 's', pickup_location_source: 'item', pickup_city: 'Denver' },
      shipTo: JSON.stringify(SHIP_TO_NY) })).rejects.toMatchObject({ code: 'PICKUP_LOCATION_MISSING', status: 409 });
    expect(alerts.reportMissingSaleLocation).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'marketplace_item', entityId: 'item-x', missing: ['street address', 'state', 'ZIP code'] }));
    expect(mockCalcCreate).not.toHaveBeenCalled();
  });
});

describe('Professional Seller default storefront location: confirm once, items inherit it', () => {
  // A Houston dealer whose merchandise is at a warehouse — NOT their legal/business address.
  const DEFAULT_HOU = { default_pickup_address_line1: '2100 Warehouse Rd', default_pickup_address_line2: null, default_pickup_city: 'Houston',
    default_pickup_state: 'TX', default_pickup_postal_code: '77020', default_pickup_country: 'US', default_pickup_confirmed_at: '2026-09-28T12:00:00Z' };
  const PRO = { id: 'sp1', user_id: 'u1', seller_type: 'estate_sale_company', is_demo: false, unsold_price_policy: null };
  const route = (handlers) => db.query.mockImplementation(async (sql, params) => {
    for (const [re, out] of handlers) if (re.test(sql)) return typeof out === 'function' ? out(params, sql) : out;
    return { rows: [], rowCount: 0 };
  });
  const storefront = require('../src/services/storefrontService');

  test('the seller confirms the default location once (complete address required); items that use it follow it', async () => {
    const calls = [];
    route([
      [/SELECT \* FROM seller_profiles WHERE user_id/, { rows: [{ ...PRO }] }],
      [/UPDATE seller_profiles SET default_pickup_address_line1/, (p) => { calls.push(['default', p]); return { rowCount: 1 }; }],
      [/UPDATE marketplace_items SET city/, (p, sql) => { calls.push(['items', p, sql]); return { rowCount: 3 }; }],
    ]);
    await expect(storefront.setDefaultPickupLocation('u1', { line1: '2100 Warehouse Rd', city: 'Houston', state: 'TX' }))
      .rejects.toMatchObject({ code: 'PICKUP_LOCATION_INCOMPLETE', missing: ['ZIP code'] });
    await storefront.setDefaultPickupLocation('u1', { line1: '2100 Warehouse Rd', city: 'Houston', state: 'tx', postal_code: '77020' });
    const d = calls.find((c) => c[0] === 'default');
    expect(d[1]).toEqual(['sp1', '2100 Warehouse Rd', null, 'Houston', 'TX', '77020', 'US']);
    const it = calls.find((c) => c[0] === 'items');
    // Only items that USE the storefront location follow it; items with their own location are untouched.
    expect(it[2]).toMatch(/pickup_location_source = 'default' OR pickup_location_source IS NULL/);
  });
  test('until confirmed, the business address is only a SUGGESTION (never used for a sale)', async () => {
    route([
      [/SELECT \* FROM seller_profiles WHERE user_id/, { rows: [{ ...PRO }] }],
      [/FROM seller_identity/, { rows: [{ address_line1: '1 Legal Plaza', city: 'Dallas', state: 'TX', postal_code: '75201' }] }],
    ]);
    const cfg = await storefront.getOwnerConfig('u1');
    expect(cfg.pickup_location).toMatchObject({ confirmed: false, address: null, suggestion: { line1: '1 Legal Plaza', city: 'Dallas' } });
    // An item that would use the unconfirmed default cannot be sold.
    expect(saleLocation.forItem({ ...PRO, pickup_location_source: 'default' })).toMatchObject({ address: null, missing: ['confirmed storefront pickup location'] });
  });
  test('a new item inherits the confirmed default automatically — no address typed', async () => {
    let params;
    route([[/FROM seller_profiles WHERE user_id/, { rows: [{ ...PRO, ...DEFAULT_HOU }] }],
      [/INSERT INTO marketplace_items/, (p) => { params = p; return { rows: [{ id: 'new' }] }; }]]);
    await items.createDirectListing('u1', { title: 'Lamp', price_cents: 5000 });
    expect(params.slice(8, 11)).toEqual(['Houston', 'TX', '77020']);                    // public city/state (+ private zip column)
    expect(params.slice(17, 24)).toEqual([null, null, null, null, null, 'US', 'default']); // nothing copied; resolved at sale time
  });
  test('without a confirmed default a live item is refused with a plain instruction (a draft is fine)', async () => {
    route([[/FROM seller_profiles WHERE user_id/, { rows: [{ ...PRO }] }], [/INSERT INTO marketplace_items/, { rows: [{ id: 'd' }] }]]);
    await expect(items.createDirectListing('u1', { title: 'Lamp', price_cents: 5000 }))
      .rejects.toMatchObject({ code: 'STOREFRONT_LOCATION_REQUIRED', status: 422 });
    await expect(items.createDirectListing('u1', { title: 'Lamp', price_cents: 5000, status: 'draft' })).resolves.toEqual({ id: 'd' });
  });
  test('"Change Location" on ONE item stores it on that item only — the default and other items are untouched', async () => {
    const writes = [];
    route([
      [/FROM seller_profiles WHERE user_id/, { rows: [{ ...PRO, ...DEFAULT_HOU }] }],
      [/SELECT \* FROM marketplace_items WHERE id/, { rows: [{ id: 'item-1', seller_id: 'sp1', status: 'active', pickup_location_source: 'default' }] }],
      [/UPDATE|INSERT|DELETE/, (p, sql) => { writes.push([sql, p]); return { rows: [{ id: 'item-1' }] }; }],
    ]);
    await items.updateItem('item-1', 'u1', { pickup_address_line1: '5 Barn Ln', pickup_city: 'Katy', pickup_state: 'TX', pickup_postal_code: '77494' });
    expect(writes).toHaveLength(1);
    const [sql, p] = writes[0];
    expect(sql).toMatch(/^UPDATE marketplace_items SET [\s\S]* WHERE id = \$1 RETURNING \*$/);
    expect(p[0]).toBe('item-1');
    expect(p).toEqual(expect.arrayContaining(['5 Barn Ln', 'Katy', 'TX', '77494', 'item']));
    expect(sql).not.toMatch(/seller_profiles|default_pickup/);
  });
  test('an item can go back to the storefront location', async () => {
    const writes = [];
    route([
      [/FROM seller_profiles WHERE user_id/, { rows: [{ ...PRO, ...DEFAULT_HOU }] }],
      [/SELECT \* FROM marketplace_items WHERE id/, { rows: [{ id: 'item-1', seller_id: 'sp1', status: 'active', pickup_location_source: 'item',
        pickup_address_line1: '5 Barn Ln', pickup_city: 'Katy', pickup_state: 'TX', pickup_postal_code: '77494' }] }],
      [/UPDATE marketplace_items/, (p) => { writes.push(p); return { rows: [{ id: 'item-1' }] }; }],
    ]);
    await items.updateItem('item-1', 'u1', { use_storefront_location: true });
    expect(writes[0]).toEqual(expect.arrayContaining(['default', 'Houston', 'TX']));
    expect(writes[0]).not.toContain('5 Barn Ln');
  });
  test('the seller sees each item\'s full effective location and where it comes from', async () => {
    route([[/FROM marketplace_items mi JOIN seller_profiles sp/, { rows: [
      { id: 'a', seller_id: 'sp1', pickup_location_source: 'default', ...DEFAULT_HOU },
      { id: 'b', seller_id: 'sp1', pickup_location_source: 'item', pickup_address_line1: '5 Barn Ln', pickup_city: 'Katy', pickup_state: 'TX', pickup_postal_code: '77494', ...DEFAULT_HOU },
    ] }]]);
    const rows = await items.listForSeller('sp1');
    expect(rows[0].location).toMatchObject({ source: 'default', address: { line1: '2100 Warehouse Rd', postal_code: '77020' } });
    expect(rows[1].location).toMatchObject({ source: 'item', address: { line1: '5 Barn Ln', city: 'Katy' } });
    expect(rows[0].default_pickup_address_line1).toBeUndefined();
  });
  test('Stripe Tax: a default-location item picked up by an out-of-state buyer is taxed at the warehouse', async () => {
    const item = { id: 'item-d', seller_id: 'sp1', pickup_location_source: 'default', ...DEFAULT_HOU };
    const loc = await orders.resolveTaxLocation({ method: 'pickup', item });
    await require('../src/services/taxCalculationService').computeTax({ buyerUserId: 'buyer-ny', taxableBaseCents: 20000,
      address: loc.address, shipFrom: loc.shipFrom, addressSource: 'shipping', reference: 't' });
    const p = sentToProvider();
    expect(p.customer_details.address).toMatchObject({ line1: '2100 Warehouse Rd', city: 'Houston', state: 'TX', postal_code: '77020' });
    expect(JSON.stringify(p)).not.toMatch(/Legal Plaza|Dallas|75201/);
  });
  test('Stripe Tax: a shipped default-location item sends the warehouse as origin and the buyer as destination', async () => {
    const item = { id: 'item-d', seller_id: 'sp1', pickup_location_source: 'default', ...DEFAULT_HOU };
    const loc = await orders.resolveTaxLocation({ method: 'shipping', item, shipTo: JSON.stringify(SHIP_TO_NY) });
    await require('../src/services/taxCalculationService').computeTax({ buyerUserId: 'buyer-ny', taxableBaseCents: 20000,
      address: loc.address, shipFrom: loc.shipFrom, addressSource: 'shipping', reference: 't' });
    const p = sentToProvider();
    expect(p.customer_details.address).toMatchObject({ state: 'NY', postal_code: '10118' });
    expect(p.ship_from_details.address).toMatchObject({ line1: '2100 Warehouse Rd', state: 'TX', postal_code: '77020' });
  });
  test('an unconfirmed default blocks checkout (no guessing from the legal address)', async () => {
    await expect(orders.resolveTaxLocation({ method: 'pickup', item: { id: 'x', seller_id: 'sp1', pickup_location_source: 'default',
      default_pickup_address_line1: '1 Legal Plaza', default_pickup_city: 'Dallas', default_pickup_state: 'TX', default_pickup_postal_code: '75201' } }))
      .rejects.toMatchObject({ code: 'PICKUP_LOCATION_MISSING' });
    expect(mockCalcCreate).not.toHaveBeenCalled();
  });
});

describe('auction lots inherit the auction location; converted lots carry it forward', () => {
  const PRO = { id: 'sp1', user_id: 'u1', seller_type: 'estate_sale_company', is_demo: false };
  test('lots have no location of their own (schema) — every lot sale uses its auction pickup address', () => {
    const migs = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).map((m) => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', m), 'utf8')).join('\n');
    const lotAlters = [...migs.matchAll(/ALTER TABLE lots\b([\s\S]*?);/gi)].map((m) => m[1]).join('\n');
    expect(lotAlters).not.toMatch(/ADD COLUMN (IF NOT EXISTS )?(street|address|city|zip|postal|pickup_address|lat|lng)\b/i);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'paymentService.js'), 'utf8');
    expect(src).toMatch(/FROM payments p JOIN auctions a ON a\.id = p\.auction_id WHERE p\.id = \$1/);
  });
  test('a converted lot inherits its auction pickup address automatically (source "auction")', async () => {
    const client = { query: jest.fn(async (sql, p) => {
      if (/FROM seller_profiles WHERE user_id/.test(sql)) return { rows: [PRO] };
      if (/FROM lots l JOIN auctions a/.test(sql)) return { rows: [{ id: 'lot1', state: 'closed', title: 'Chair', bid_count: 0, reserve_cents: 4000,
        auction_id: 'auc-tx', city: 'Austin', a_state: 'TX', zip: '78701', a_street: '100 Congress Ave' }] };
      if (/INSERT INTO marketplace_items/.test(sql)) return { rows: [{ params: p }] };
      return { rows: [] };
    }), release: jest.fn() };
    db.connect.mockResolvedValue(client);
    const out = await items.convertLotToListing('lot1', 'u1');
    const p = out.item.params;
    expect(p[17]).toBe('active');
    expect(p.slice(21, 28)).toEqual(['100 Congress Ave', null, 'Austin', 'TX', '78701', 'US', 'auction']);
  });
});

describe('PUBLIC = city and state only (storefront items)', () => {
  const ROW = { ...ITEM_CO, id: 'i', title: 'Lamp', city: 'Denver', state: 'CO', zip: '80202', seller_id: 'sp1', source_auction_id: 'auc-1',
    source_lot_id: 'lot-1', converted_by_user_id: 'u9', pending_order_id: 'o9', pickup_location_source: 'item',
    default_pickup_address_line1: '2100 Warehouse Rd', default_pickup_postal_code: '77020', seller_type: 'estate_sale_company',
    show_branding_to_buyers: true, seller_name: 'Acme Estates', storefront_slug: 'acme' };
  test('the public item carries city/state and nothing that locates the pickup address or links to it', () => {
    const pub = items.publicItem(ROW);
    expect(pub).toMatchObject({ id: 'i', city: 'Denver', state: 'CO', seller_name: 'Acme Estates', source_lot_id: true });
    const json = JSON.stringify(pub);
    expect(json).not.toMatch(/1600 Market|80202|Warehouse|77020|auc-1|lot-1|u9|o9|sp1/);
    for (const k of ['zip', 'pickup_address_line1', 'pickup_postal_code', 'seller_id', 'source_auction_id', 'default_pickup_address_line1']) {
      expect(pub).not.toHaveProperty(k);
    }
  });
  test('an anonymous (branding off) seller stays anonymous on the item page', () => {
    const pub = items.publicItem({ ...ROW, show_branding_to_buyers: false });
    expect(pub.seller_name).toBeNull();
    expect(pub.storefront_slug).toBeNull();
  });
  test('the buyer gets the full pickup address only in the PAID order confirmation', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'marketplaceOrderNotifier.js'), 'utf8');
    expect(src).toMatch(/function pickupBlock\(o\) \{\s*if \(o\.fulfillment_method === 'shipping'\) return '';/);
    expect(src.indexOf('${pickupBlock(o)}')).toBeGreaterThan(src.indexOf('async function sendPaid('));
    // The pre-payment quote and the buyer's order views carry no pickup address.
    const ord = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
    const quote = ord.slice(ord.indexOf('async function quote('), ord.indexOf('// ── PaymentIntent helpers'));
    const quoteReturn = quote.slice(quote.indexOf('  return {'));
    expect(quoteReturn).not.toMatch(/loc\b|address|line1|pickup_/);
    const pubOrder = ord.slice(ord.indexOf('function publicOrder('), ord.indexOf('\n}', ord.indexOf('function publicOrder(')));
    expect(pubOrder).not.toMatch(/pickup_address|default_pickup/);
  });
  test('admins see the effective pickup location in the (admin-only) order list', () => {
    const ord = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
    expect(ord).toMatch(/pickup_location: \(\(\) => \{ const e = saleLocation\.forItem\(r\);/);
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'marketplaceOrders.js'), 'utf8');
    expect(route).toMatch(/router\.get\('\/admin\/orders', roleMiddleware\(\['admin'\]\)/);
  });
});

describe('saleLocation helper', () => {
  test('names exactly what is missing and validates US state/ZIP', () => {
    expect(saleLocation.missingParts({ line1: '1 A St', city: 'Denver', state: 'CO', postal_code: '80202' })).toEqual([]);
    expect(saleLocation.missingParts({ line1: '1 A St', city: 'Denver', state: 'Colorado', postal_code: '8020' })).toEqual(['state', 'ZIP code']);
    expect(saleLocation.describeMissing(['street address', 'state', 'ZIP code'])).toBe('street address, state and ZIP code');
  });
  test('no state is hard-coded as a default jurisdiction anywhere in the tax path', () => {
    for (const f of ['src/lib/saleLocation.js', 'src/services/taxCalculationService.js', 'src/services/marketplaceOrderService.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/const US_STATES[\s\S]*?\);/, '');
      expect(src).not.toMatch(/['"](MI|TX|Michigan)['"]/);
    }
  });
});
