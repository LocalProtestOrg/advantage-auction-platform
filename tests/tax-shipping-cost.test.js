'use strict';

/**
 * Shipping in the sales-tax request (2026-11-12). A storefront order sends the goods as the line item and the shipping
 * charge separately as the calculation's shipping_cost, so the provider applies each state's own rule for taxing shipping
 * (previously goods + shipping were sent as one goods line, taxing shipping as goods everywhere). Auction calls pass no
 * shipping and their request is exactly as before. The processor is a mocked client; nothing leaves the machine.
 */

process.env.STRIPE_SECRET_KEY = 'sk_test_unit_only';
process.env.STRIPE_TAX_ENABLED = 'true';

const mockCalcCreate = jest.fn(async () => ({ id: 'taxcalc_1', tax_amount_exclusive: 47, tax_breakdown: [{ taxability_reason: 'standard_rated' }] }));
jest.mock('stripe', () => jest.fn(() => ({ tax: { calculations: { create: mockCalcCreate } } })));
jest.mock('../src/services/taxExemptionService', () => ({ effectiveExemptionForSale: jest.fn(async () => null) }));

const fs = require('fs');
const path = require('path');
const tax = require('../src/services/taxCalculationService');

const NJ = { line1: '10 Broad St', city: 'Newark', state: 'NJ', postal_code: '07102', country: 'US' };
const ORIGIN = { line1: '1 Nassau St', city: 'Princeton', state: 'NJ', postal_code: '08542', country: 'US' };
const sent = () => { expect(mockCalcCreate).toHaveBeenCalledTimes(1); return mockCalcCreate.mock.calls[0][0]; };

beforeEach(() => jest.clearAllMocks());

test('auction call (no shippingCents): the exact request as before, with no shipping_cost', async () => {
  const r = await tax.computeTax({ buyerUserId: 'b', taxableBaseCents: 11800, address: ORIGIN, shipFrom: ORIGIN, addressSource: 'shipping', reference: 'auction-sale-1' });
  expect(r).toMatchObject({ enabled: true, taxCents: 47, calculationId: 'taxcalc_1' });
  expect(sent()).toEqual({
    currency: 'usd',
    line_items: [{ amount: 11800, reference: 'auction-sale-1', tax_behavior: 'exclusive', tax_code: tax.DEFAULT_TAX_CODE }],
    customer_details: { address: { line1: ORIGIN.line1, line2: undefined, city: ORIGIN.city, state: 'NJ', postal_code: ORIGIN.postal_code, country: 'US' }, address_source: 'shipping' },
    ship_from_details: { address: { line1: ORIGIN.line1, line2: undefined, city: ORIGIN.city, state: 'NJ', postal_code: ORIGIN.postal_code, country: 'US' } },
  });
});

test('storefront shipped order: goods as the line item, shipping once as shipping_cost (tax-exclusive)', async () => {
  const r = await tax.computeTax({ buyerUserId: 'b', taxableBaseCents: 300, shippingCents: 200, address: NJ, shipFrom: ORIGIN, reference: 'marketplace-order:MO-1' });
  expect(r.taxCents).toBe(47);   // the provider's total, which includes any tax on shipping
  const p = sent();
  expect(p.line_items).toEqual([{ amount: 300, reference: 'marketplace-order:MO-1', tax_behavior: 'exclusive', tax_code: tax.DEFAULT_TAX_CODE }]);
  expect(p.shipping_cost).toEqual({ amount: 200, tax_behavior: 'exclusive' });
  expect(p.customer_details.address).toMatchObject({ state: 'NJ', postal_code: '07102' });
});

test('no shipping (pickup, free shipping) or a bad value: no shipping_cost is sent', async () => {
  for (const shippingCents of [0, null, undefined, -5, 'abc']) {
    mockCalcCreate.mockClear();
    await tax.computeTax({ buyerUserId: 'b', taxableBaseCents: 300, shippingCents, address: NJ, reference: 'r' });
    expect(sent()).not.toHaveProperty('shipping_cost');
    expect(sent().line_items[0].amount).toBe(300);
  }
});

test('tax off: no request at all, whatever the shipping', async () => {
  process.env.STRIPE_TAX_ENABLED = 'false';
  try {
    expect(await tax.computeTax({ buyerUserId: 'b', taxableBaseCents: 300, shippingCents: 200, address: NJ })).toEqual({ enabled: false, taxCents: 0, calculationId: null, exempt: false });
    expect(mockCalcCreate).not.toHaveBeenCalled();
  } finally { process.env.STRIPE_TAX_ENABLED = 'true'; }
});

test('callers: storefront quote and order pass goods and shipping separately; auction callers pass no shipping', () => {
  const mo = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'marketplaceOrderService.js'), 'utf8');
  expect(mo).toMatch(/computeTax\(\{\s*buyerUserId, taxableBaseCents: goods, shippingCents,/);
  expect(mo).toMatch(/computeTax\(\{ buyerUserId, taxableBaseCents: Number\(order\.item_price_cents\),\s*shippingCents: Number\(order\.shipping_cents\) \|\| 0,/);
  expect(mo).not.toMatch(/taxableBaseCents: (taxable|taxableBase)\b/);
  const pay = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'paymentService.js'), 'utf8');
  expect(pay).not.toMatch(/shippingCents/);
});
