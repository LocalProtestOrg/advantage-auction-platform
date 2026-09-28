'use strict';

/**
 * Platform privacy rule (owner, 2026-09-28): PUBLIC = CITY AND STATE ONLY for auctions, lots and storefront items.
 * No public/unauthenticated surface may deliver a street address (or any part of it), unit, ZIP, precise coordinates,
 * the seller's legal address or a private pickup address — not in visible text, JSON, HTML source, structured data,
 * SEO metadata, feeds, widgets or emails sent before the authorized disclosure point.
 *
 * These tests call the real public route handlers with a recording database and assert on what they SELECT and
 * return, plus source-level guards for server-rendered HTML and structured data.
 */

jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// A row a careless query might return — every private field present — so a leak would show up in the response.
const LEAKY = { id: '11111111-1111-4111-8111-111111111111', title: 'Estate', city: 'Houston', state: 'published', address_state: 'TX',
  zip: '77002', street_address: '9 Dock Rd', internal_lat: 29.7604321, internal_lng: -95.3698021, address_encrypted: 'x',
  lat: 29.76043, lng: -95.36980, total_count: 1, seller_type: 'estate_sale_company', show_branding_to_buyers: true };

function handlerFor(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not found: ' + method + ' ' + routePath);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
async function call(handle, { params = {}, query = {} } = {}) {
  let body = null; let status = 200;
  const res = { set() { return res; }, status(c) { status = c; return res; }, json(b) { body = b; return res; } };
  await handle({ params, query, headers: {}, get() { return ''; } }, res, (e) => { if (e) throw e; });
  return { status, body };
}
const selected = () => db.query.mock.calls.map(([sql]) => String(sql));

beforeEach(() => { jest.clearAllMocks(); db.query.mockImplementation(async () => ({ rows: [{ ...LEAKY }] })); });

describe('public auction endpoints never select private location fields', () => {
  const publicRouter = require('../src/routes/public');
  const auctionsSql = () => selected().filter((s) => /FROM auctions a/.test(s));

  test.each([
    ['get', '/auctions', {}],
    ['get', '/auctions/:id', { params: { id: LEAKY.id } }],
    ['get', '/auctions/near', { query: { lat: '29.7', lng: '-95.3' } }],
    ['get', '/featured-auctions', { query: { lat: '29.7', lng: '-95.3' } }],
  ])('%s /api/public%s: no ZIP/street/internal coords; the public point is coarsened in SQL', async (method, p, req) => {
    await call(handlerFor(publicRouter, method, p), req).catch(() => {});
    const sqls = auctionsSql();
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      expect(sql).not.toMatch(/\ba\.zip\b(?!,\s*3\))/);           // only left(a.zip, 3) for area filtering is allowed
      expect(sql).not.toMatch(/street_address|address_encrypted|internal_lat|internal_lng|location_fingerprint|seller_identity/);
      expect(sql).not.toMatch(/radians\(a\.lat\)|radians\(a\.lng\)/);  // distance maths only ever sees the coarse point
      if (/\ba\.lat\b/.test(sql)) expect(sql).toMatch(/round\(a\.lat::numeric, 2\)::float/);
    }
  });

  test('the marketplace feed sends no auction ZIP, a coarse point, whole-mile distances, and filters auctions by 3-digit area only', async () => {
    db.query.mockImplementation(async () => ({ rows: [{ kind: 'auction', source_family: 'advantage_auction', ref_id: LEAKY.id, title: 'E',
      city: 'Houston', state: 'TX', zip: null, lat: 29.76, lng: -95.37, distance_mi: 3.46, total_count: 1 }] }));
    const { body } = await call(handlerFor(publicRouter, 'get', '/marketplace/feed'), { query: { zip: '77002', lat: '29.7', lng: '-95.3' } });
    const sql = selected().find((s) => /WITH feed AS/.test(s));
    const auctionBranch = sql.slice(sql.indexOf("'advantage_auction'::text"), sql.indexOf('UNION ALL'));
    expect(auctionBranch).toMatch(/NULL::text AS zip, left\(a\.zip, 3\) AS zip3, round\(a\.lat::numeric, 2\)::float AS lat/);
    expect(sql).toMatch(/feed\.source_family = 'advantage_auction' AND feed\.zip3 = left\(\$\d+, 3\)/);
    const item = body.items ? body.items[0] : body.data[0];
    expect(item.zip).toBeNull();
    expect(item.distance_mi).toBe(3);
  });

  test('GET /api/auctions/:id/summary (buyer-facing, no auth) returns city/state only', async () => {
    const auctionsRouter = require('../src/routes/auctions');
    db.query.mockImplementation(async (sql) => {
      if (/FROM auctions a/.test(sql)) return { rows: [{ id: LEAKY.id, title: 'Estate', state: 'published', city: 'Houston', address_state: 'TX', seller_type: 'estate_sale_company' }] };
      return { rows: [] };
    });
    const { body } = await call(handlerFor(auctionsRouter, 'get', '/:auctionId/summary'), { params: { auctionId: LEAKY.id } });
    const sql = selected().find((s) => /FROM auctions a/.test(s));
    expect(sql).not.toMatch(/a\.zip|street_address|address_encrypted|internal_lat/);
    expect(body.data).toMatchObject({ city: 'Houston', address_state: 'TX' });
    expect(body.data).not.toHaveProperty('pickup_street');
    expect(body.data).not.toHaveProperty('zip');
  });
});

describe('server-rendered HTML, structured data, widgets and pages', () => {
  test('structured data (JSON-LD) and share metadata carry no street address, ZIP or geo coordinates', () => {
    for (const f of ['src/services/shareMetaService.js', 'src/services/storefrontService.js']) {
      const src = read(f);
      expect(src).not.toMatch(/streetAddress|postalCode|"geo"|GeoCoordinates|latitude|longitude/);
    }
    const server = read('server.js');
    const itemSsr = server.slice(server.indexOf("'/items"), server.indexOf("'/items") + 4000);
    expect(itemSsr).not.toMatch(/streetAddress|postalCode|pickup_address|\.zip\b/);
  });
  test('the white-label widget feed is city/state only', () => {
    const src = read('src/services/widgetService.js');
    expect(src).not.toMatch(/a\.zip|street_address|a\.lat|a\.lng|internal_lat/);
  });
  test('the public storefront never returns the seller default pickup location or legal address', () => {
    const src = read('src/services/storefrontService.js');
    const pub = src.slice(src.indexOf('async function getPublicData('), src.indexOf('// SSR metadata'));
    expect(pub).not.toMatch(/default_pickup|seller_identity|pickup_address/);
    const items = read('src/services/marketplaceItemService.js');
    const list = items.slice(items.indexOf('async function listPublicForSeller('), items.indexOf('async function getPublicItem('));
    expect(list).not.toMatch(/\bzip\b|pickup_address|pickup_city|pickup_postal|default_pickup|street/);   // pickup_group is a batch label
  });
  test('public pages do not render any part of a street address or ZIP for auctions', () => {
    expect(read('public/auction-view.html')).not.toMatch(/pickup_street|auctionSummary\.zip|d\.zip/);
    expect(read('public/widgets/shared/member-shell.js')).not.toMatch(/pickup_street/);
  });
});

describe('disclosure point and operational access are preserved', () => {
  test('auctions: the full pickup address goes to the buyer only in the post-payment success package', () => {
    const rec = read('src/services/combinedReceiptService.js');
    const successIdx = rec.indexOf('async function sendSuccessPackage(');
    expect(successIdx).toBeGreaterThan(-1);
    // payment-required / reminder emails (before payment) summarise the area only
    const before = rec.slice(rec.indexOf('async function sendPaymentRequired('), rec.indexOf('async function sendPaymentRequired(') + 3000);
    expect(before).not.toMatch(/street_address/);
  });
  test('admins keep the full auction address in the pickup packet', () => {
    expect(read('src/services/pickupPacketService.js')).toMatch(/street_address/);
  });
});

describe('public business/contact address and private pickup location stay separate (owner decision 5)', () => {
  const sf = read('src/services/storefrontService.js');
  test('the public storefront contact address comes only from the seller\'s voluntary public config', () => {
    const pub = sf.slice(sf.indexOf('async function getPublicData('), sf.indexOf('// SSR metadata'));
    expect(pub).toMatch(/address: cfg\.address,/);
    expect(pub).not.toMatch(/default_pickup|pickup_address|seller_identity/);
  });
  test('saving the private pickup location never writes the public storefront config, and vice versa', () => {
    const setDefault = sf.slice(sf.indexOf('async function setDefaultPickupLocation('), sf.indexOf('async function updateConfig('));
    expect(setDefault).not.toMatch(/storefront\s*=|sanitizeConfig|cfg\.address/);
    const update = sf.slice(sf.indexOf('async function updateConfig('), sf.indexOf('// ── Public storefront aggregation'));
    expect(update).not.toMatch(/default_pickup/);
    expect(read('src/services/marketplaceItemService.js')).not.toMatch(/storefront\s*->>\s*'address'|cfg\.address/);
  });
});
