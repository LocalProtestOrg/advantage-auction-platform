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
const ITEM_CO = { id: 'item-co', seller_id: 'seller-co', pickup_address_line1: '1600 Market St', pickup_city: 'Denver', pickup_state: 'CO',
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
    await expect(orders.resolveTaxLocation({ method: 'shipping', item: { id: 'item-x', seller_id: 's', pickup_city: 'Denver' },
      shipTo: JSON.stringify(SHIP_TO_NY) })).rejects.toMatchObject({ code: 'PICKUP_LOCATION_MISSING', status: 409 });
    expect(alerts.reportMissingSaleLocation).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'marketplace_item', entityId: 'item-x', missing: ['street address', 'state', 'ZIP code'] }));
    expect(mockCalcCreate).not.toHaveBeenCalled();
  });
});

describe('storefront items: the pickup location is real, required to go live, and private until purchase', () => {
  const PRO = { id: 'sp1', user_id: 'u1', seller_type: 'estate_sale_company', is_demo: false };
  const route = (handlers) => db.query.mockImplementation(async (sql, params) => {
    for (const [re, out] of handlers) if (re.test(sql)) return typeof out === 'function' ? out(params) : out;
    return { rows: [] };
  });

  test('a live item cannot be created without a complete pickup location (a draft can)', async () => {
    route([[/FROM seller_profiles WHERE user_id/, { rows: [PRO] }], [/INSERT INTO marketplace_items/, { rows: [{ id: 'new' }] }]]);
    await expect(items.createDirectListing('u1', { title: 'Lamp', price_cents: 5000, city: 'Denver', state: 'CO' }))
      .rejects.toMatchObject({ code: 'PICKUP_LOCATION_REQUIRED', status: 422 });
    await expect(items.createDirectListing('u1', { title: 'Lamp', price_cents: 5000, status: 'draft' })).resolves.toEqual({ id: 'new' });
  });
  test('a complete pickup location is stored on the item as the seller\'s choice', async () => {
    route([[/FROM seller_profiles WHERE user_id/, { rows: [PRO] }], [/INSERT INTO marketplace_items/, (p) => ({ rows: [{ params: p }] })]]);
    const out = await items.createDirectListing('u1', { title: 'Lamp', price_cents: 5000, pickup_address_line1: '1600 Market St',
      pickup_city: 'Denver', pickup_state: 'co', pickup_postal_code: '80202' });
    expect(out.params.slice(17, 24)).toEqual(['1600 Market St', null, 'Denver', 'CO', '80202', 'US', 'seller']);
  });
  test('converted from an auction lot → inherits that auction\'s pickup address (source "auction")', async () => {
    const client = { query: jest.fn(async (sql, p) => {
      if (/FROM seller_profiles WHERE user_id/.test(sql)) return { rows: [PRO] };
      if (/FROM lots l JOIN auctions a/.test(sql)) return { rows: [{ id: 'lot1', state: 'closed', title: 'Chair', bid_count: 0, reserve_cents: 4000,
        auction_id: 'auc-tx', city: 'Austin', a_state: 'TX', zip: '78701', a_street: '100 Congress Ave' }] };
      if (/INSERT INTO marketplace_items/.test(sql)) return { rows: [{ params: p }] };
      return { rows: [] };
    }), release: jest.fn() };
    db.connect.mockResolvedValue(client);   // the real withTransaction runs BEGIN/COMMIT on this client
    const out = await items.convertLotToListing('lot1', 'u1');
    const p = out.item.params;
    expect(p[17]).toBe('active');
    expect(p.slice(21, 28)).toEqual(['100 Congress Ave', null, 'Austin', 'TX', '78701', 'US', 'auction']);
  });
  test('the public item never returns the pickup street address or ZIP (city/state only)', () => {
    const pub = items.publicItem({ ...ITEM_CO, id: 'i', title: 'Lamp', city: 'Denver', state: 'CO', zip: '80202',
      pickup_location_source: 'seller' });
    expect(pub).toMatchObject({ id: 'i', city: 'Denver', state: 'CO' });
    expect(JSON.stringify(pub)).not.toMatch(/1600 Market|80202/);
  });
  test('the buyer gets the full pickup address only in the PAID order confirmation', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'marketplaceOrderNotifier.js'), 'utf8');
    expect(src).toMatch(/function pickupBlock\(o\) \{\s*if \(o\.fulfillment_method === 'shipping' \|\| !o\.pickup_address_line1\) return '';/);
    expect(src.indexOf('${pickupBlock(o)}')).toBeGreaterThan(src.indexOf('async function sendPaid('));
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
