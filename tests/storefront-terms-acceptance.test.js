'use strict';

/**
 * Storefront checkout and the Buyer Terms (owner direction 2026-11-06): the buyer's "I have read and agree" box is an
 * acceptance of the CURRENT terms version, recorded in terms_acceptances (with address and browser) like every other
 * acceptance. A page that showed an older version is refused (TERMS_CHANGED) before anything is recorded or reserved.
 */
let mockClient = null;
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/services/agreementService', () => ({ storefrontAgreementStatus: jest.fn(async () => ({ ok: true, reason: 'signed' })), autoSendAgreement: jest.fn(async () => null) }));
jest.mock('../src/services/sellerSaleEligibility', () => ({ assertSellerCanSell: jest.fn(async () => true) }));
jest.mock('../src/utils/withTransaction', () => ({ withTransaction: (fn) => fn(mockClient) }));
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => null) }));

const db = require('../src/db');
const svc = require('../src/services/marketplaceOrderService');

const CURRENT = { id: 'tv-4', kind: 'buyer_terms', version_int: 4, title: 'T', body_markdown: 'x', includes_sales_near_you: false };
let inserts;
beforeEach(() => {
  inserts = [];
  process.env.MARKETPLACE_CHECKOUT_ENABLED = 'true';
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM terms_versions\s+WHERE kind = \$1 AND is_current = true/.test(sql)) return { rows: [CURRENT] };
    if (/INSERT INTO terms_acceptances/.test(sql)) { inserts.push(params); return { rows: [{ id: 'acc-1' }], rowCount: 1 }; }
    if (/JOIN seller_profiles sp/.test(sql)) return { rows: [{ id: 'item-1', seller_id: 'seller-1', seller_user_id: 'su', seller_type: 'estate_sale_company', platform_fee_bps: 400, price_cents: 100000, status: 'active', shippable: false, shipping_cost_cents: null,
      pickup_location_source: 'item', pickup_address_line1: '9 Dock Rd', pickup_city: 'Houston', pickup_state: 'TX', pickup_postal_code: '77002', pickup_country: 'US' }] };
    if (/FROM marketplace_tax_jurisdictions WHERE state = \$1/.test(sql)) return { rows: [{ state: 'TX', remitter: 'seller_direct' }] };   // the sale state's approved tax rule (test)
    return { rows: [] };
  });
  // The locked item shows sold: the order stops right after the acceptance step, before any payment.
  mockClient = { query: async (sql) => (/FOR UPDATE/.test(sql) ? { rows: [{ id: 'item-1', status: 'sold', price_cents: 100000 }] } : { rows: [] }) };
});

test('ticking the box records acceptance of the current Buyer Terms version with address and browser', async () => {
  await expect(svc.createOrder('item-1', 'buyer-1', { policiesAcknowledged: true, fulfillment_method: 'pickup',
    expectedBuyerTermsVersion: 4, ip: '192.0.2.7', userAgent: 'UA-Checkout' })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  expect(inserts).toEqual([['buyer-1', 'tv-4', '192.0.2.7', 'UA-Checkout']]);
});

test('a page that showed an older version is refused with TERMS_CHANGED and nothing is recorded', async () => {
  await expect(svc.createOrder('item-1', 'buyer-1', { policiesAcknowledged: true, fulfillment_method: 'pickup', expectedBuyerTermsVersion: 3 }))
    .rejects.toMatchObject({ code: 'TERMS_CHANGED', status: 409 });
  expect(inserts).toEqual([]);
});

test('without the box ticked nothing is recorded (POLICIES_ACK_REQUIRED, unchanged)', async () => {
  await expect(svc.createOrder('item-1', 'buyer-1', { policiesAcknowledged: false, fulfillment_method: 'pickup' })).rejects.toMatchObject({ code: 'POLICIES_ACK_REQUIRED' });
  expect(inserts).toEqual([]);
});

test('the route passes the version shown and the request evidence; the page sends the version and agrees to the full terms', () => {
  const fs = require('fs'); const path = require('path');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'marketplaceOrders.js'), 'utf8');
  expect(route).toMatch(/expectedBuyerTermsVersion: \(req\.body \|\| \{\}\)\.expected_buyer_terms_version, \.\.\.require\('\.\.\/services\/termsService'\)\.requestEvidence\(req\)/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'item.html'), 'utf8');
  expect(page).toMatch(/I have read and agree to /);
  expect(page).toMatch(/href="\/terms\.html"[^>]*>Terms of Service<\/a> and <a href="\/buyer-terms\.html"/);
  expect(page).toMatch(/body\.expected_buyer_terms_version=BUYER_TERMS_V/);
});
