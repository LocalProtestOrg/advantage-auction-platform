'use strict';

/**
 * Shipping permission — owner policy (2026-10-12).
 *   Professional Sellers (auction_house / estate_sale_company / professional_liquidator) choose
 *   whether their listings offer shipping. Individual Sellers (business / private / other / untyped)
 *   may NOT enable shipping unless Advantage.Bid enabled it for them
 *   (seller_profiles.capabilities.shipping_enabled === true). Admins may always set shipping.
 * When not allowed, the shipping field is IGNORED (never a hard error), and existing data is untouched.
 * Covers: PUT /api/lots/:lotId, POST /api/auctions/:auctionId/lots, auctionService.createAuction /
 * updateAuction, GET /api/sellers/me shipping_allowed flag, and the public shipping page copy.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/services/lotService', () => ({
  createLot: jest.fn(async (auctionId, userId, data) => ({ id: 'lot-new', ...data })),
  adminCreateLot: jest.fn(async (auctionId, data) => ({ id: 'lot-new', ...data })),
}));

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const lotService = require('../src/services/lotService');
const lotsRouter = require('../src/routes/lots');
const auctionsRouter = require('../src/routes/auctions');
const sellersRouter = require('../src/routes/sellers');
const auctionService = require('../src/services/auctionService');
const { shippingAllowed } = require('../src/services/sellerTypeRules');

const AID = '11111111-1111-4111-8111-111111111111';
const LID = '22222222-2222-4222-8222-222222222222';
const SPID = '33333333-3333-4333-8333-333333333333';

function handlerFor(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  const st = layer.route.stack; return st[st.length - 1].handle;
}
async function call(router, method, routePath, { params = {}, body = {}, user }) {
  let status = 200, out = null;
  const res = { set() { return res; }, status(c) { status = c; return res; }, json(b) { out = b; return res; } };
  await handlerFor(router, method, routePath)({ params, body, query: {}, headers: {}, user }, res, (e) => { if (e) throw e; });
  return { status, body: out };
}

// Seller under test: seller_type + capabilities drive every query that looks them up.
let seller = { seller_type: 'private', capabilities: {} };
let captured = {};
beforeEach(() => {
  jest.clearAllMocks();
  captured = {};
  db.query.mockImplementation(async (sql, params) => {
    if (/SELECT 1 FROM lots l/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/SELECT auction_id FROM lots WHERE id/.test(sql)) return { rows: [{ auction_id: AID }] };
    if (/SELECT a\.state, sp\.seller_type(?:, sp\.user_id AS owner_user_id)?\s+FROM auctions a/.test(sql)) return { rows: [{ state: 'draft', seller_type: seller.seller_type, owner_user_id: 'u1' }] };   // the seller under test owns it
    if (/sp\.capabilities/.test(sql) || /capabilities FROM seller_profiles/.test(sql)) {
      return { rows: [{ id: SPID, user_id: 'u1', seller_type: seller.seller_type, show_branding_to_buyers: false, capabilities: seller.capabilities }] };
    }
    if (/SELECT sp\.seller_type FROM/.test(sql) || /SELECT seller_type FROM seller_profiles/.test(sql)) return { rows: [{ seller_type: seller.seller_type }] };
    if (/UPDATE lots/.test(sql)) { captured.lotUpdate = params; return { rows: [{ id: LID, auction_id: AID, shippable: params[13] }] }; }
    if (/INSERT INTO auctions/.test(sql)) { captured.auctionInsert = params; return { rows: [{ id: AID, shipping_available: params[16] }] }; }
    if (/SELECT state FROM auctions WHERE id/.test(sql)) return { rows: [{ state: 'draft' }] };
    if (/UPDATE auctions/.test(sql)) { captured.auctionUpdateSql = sql; captured.auctionUpdateParams = params; return { rows: [{ id: AID }] }; }
    return { rows: [] };
  });
});

const INDIVIDUAL = { seller_type: 'private', capabilities: {} };
const INDIVIDUAL_BUSINESS = { seller_type: 'business', capabilities: null };
const PROFESSIONAL = { seller_type: 'estate_sale_company', capabilities: {} };
const ENABLED_INDIVIDUAL = { seller_type: 'private', capabilities: { shipping_enabled: true } };
const SELLER_USER = { id: 'u1', role: 'seller' };
const ADMIN_USER = { id: 'admin-1', role: 'admin' };

describe('shippingAllowed (pure)', () => {
  test('admin always; professionals always', () => {
    expect(shippingAllowed({ role: 'admin', sellerType: 'private' })).toBe(true);
    ['auction_house', 'estate_sale_company', 'professional_liquidator'].forEach((t) =>
      expect(shippingAllowed({ role: 'seller', sellerType: t })).toBe(true));
  });
  test('individual sellers are not allowed by default', () => {
    ['private', 'business', 'other', null, undefined].forEach((t) =>
      expect(shippingAllowed({ role: 'seller', sellerType: t, capabilities: {} })).toBe(false));
    expect(shippingAllowed()).toBe(false);
  });
  test('individual seller with admin-enabled capabilities.shipping_enabled === true is allowed', () => {
    expect(shippingAllowed({ role: 'seller', sellerType: 'private', capabilities: { shipping_enabled: true } })).toBe(true);
    expect(shippingAllowed({ role: 'seller', sellerType: 'private', capabilities: { shipping_enabled: 'true' } })).toBe(false);
  });
});

describe('PUT /api/lots/:lotId — shippable', () => {
  const put = (user) => call(lotsRouter, 'put', '/:lotId', { params: { lotId: LID }, body: { title: 'Chair', size_category: 'A', shippable: true }, user });
  test('Individual Seller: shippable ignored (null → stored value preserved), not an error', async () => {
    seller = INDIVIDUAL;
    const r = await put(SELLER_USER);
    expect(r.status).toBe(200);
    expect(captured.lotUpdate[13]).toBeNull();
  });
  test('Individual business-type seller: also ignored', async () => {
    seller = INDIVIDUAL_BUSINESS;
    await put(SELLER_USER);
    expect(captured.lotUpdate[13]).toBeNull();
  });
  test('Professional Seller: shippable written', async () => {
    seller = PROFESSIONAL;
    await put(SELLER_USER);
    expect(captured.lotUpdate[13]).toBe(true);
  });
  test('Admin: shippable written even for an Individual Seller lot', async () => {
    seller = INDIVIDUAL;
    await put(ADMIN_USER);
    expect(captured.lotUpdate[13]).toBe(true);
  });
  test('Individual Seller with capabilities.shipping_enabled: shippable written', async () => {
    seller = ENABLED_INDIVIDUAL;
    await put(SELLER_USER);
    expect(captured.lotUpdate[13]).toBe(true);
  });
});

describe('POST /api/auctions/:auctionId/lots — shippable', () => {
  const post = (user) => call(auctionsRouter, 'post', '/:auctionId/lots', { params: { auctionId: AID }, body: { title: 'Lamp', shippable: true }, user });
  test('Individual Seller: forced false', async () => {
    seller = INDIVIDUAL;
    const r = await post(SELLER_USER);
    expect(r.status).toBe(201);
    expect(lotService.createLot.mock.calls[0][2].shippable).toBe(false);
  });
  test('Professional Seller: true', async () => {
    seller = PROFESSIONAL;
    await post(SELLER_USER);
    expect(lotService.createLot.mock.calls[0][2].shippable).toBe(true);
  });
  test('Admin: true', async () => {
    seller = INDIVIDUAL;
    await post(ADMIN_USER);
    expect(lotService.adminCreateLot.mock.calls[0][1].shippable).toBe(true);
  });
  test('Individual Seller with capabilities.shipping_enabled: true', async () => {
    seller = ENABLED_INDIVIDUAL;
    await post(SELLER_USER);
    expect(lotService.createLot.mock.calls[0][2].shippable).toBe(true);
  });
});

describe('auctionService.createAuction — shippingAvailable', () => {
  const create = (actorRole) => auctionService.createAuction({ sellerId: SPID, title: 'Estate', shippingAvailable: true, actorRole, actorUserId: 'u1' });
  test('Individual Seller: created with shipping_available false', async () => {
    seller = INDIVIDUAL;
    await create('seller');
    expect(captured.auctionInsert[16]).toBe(false);
  });
  test('Professional Seller: true', async () => {
    seller = PROFESSIONAL;
    await create('seller');
    expect(captured.auctionInsert[16]).toBe(true);
  });
  test('Admin: true', async () => {
    seller = INDIVIDUAL;
    await create('admin');
    expect(captured.auctionInsert[16]).toBe(true);
  });
  test('Individual Seller with capabilities.shipping_enabled: true', async () => {
    seller = ENABLED_INDIVIDUAL;
    await create('seller');
    expect(captured.auctionInsert[16]).toBe(true);
  });
});

describe('auctionService.updateAuction — shipping_available', () => {
  const update = (role) => auctionService.updateAuction(AID, 'u1', { title: 'Estate', shipping_available: true }, role);
  test('Individual Seller: shipping_available dropped from the UPDATE; other fields still saved', async () => {
    seller = INDIVIDUAL;
    const out = await update('seller');
    expect(out).toBeTruthy();
    expect(captured.auctionUpdateSql).toMatch(/title = \$1/);
    expect(captured.auctionUpdateSql).not.toMatch(/shipping_available/);
  });
  test('Professional Seller: written', async () => {
    seller = PROFESSIONAL;
    await update('seller');
    expect(captured.auctionUpdateSql).toMatch(/shipping_available = \$\d+/);
  });
  test('Admin: written', async () => {
    seller = INDIVIDUAL;
    await update('admin');
    expect(captured.auctionUpdateSql).toMatch(/shipping_available = \$\d+/);
  });
  test('Individual Seller with capabilities.shipping_enabled: written', async () => {
    seller = ENABLED_INDIVIDUAL;
    await update('seller');
    expect(captured.auctionUpdateSql).toMatch(/shipping_available = \$\d+/);
  });
});

describe('GET /api/sellers/me — server-computed shipping_allowed (UI hint)', () => {
  const me = (user) => call(sellersRouter, 'get', '/me', { user });
  test('Individual: false; capabilities map not exposed', async () => {
    seller = INDIVIDUAL;
    const r = await me(SELLER_USER);
    expect(r.body.data.shipping_allowed).toBe(false);
    expect(r.body.data).not.toHaveProperty('capabilities');
  });
  test('Professional: true; enabled Individual: true', async () => {
    seller = PROFESSIONAL;
    expect((await me(SELLER_USER)).body.data.shipping_allowed).toBe(true);
    seller = ENABLED_INDIVIDUAL;
    expect((await me(SELLER_USER)).body.data.shipping_allowed).toBe(true);
  });
});

describe('seller UI hides shipping toggles unless allowed', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  test('seller-create.html: shipping settings hidden by default, revealed on shipping_allowed', () => {
    const html = read('public/seller-create.html');
    expect(html).toMatch(/id="shipping-settings" style="display:none"/);
    expect(html).toMatch(/profile\.shipping_allowed === true/);
  });
  test('lot-builder.html: lot shipping field hidden by default, revealed on shipping_allowed', () => {
    const html = read('public/lot-builder.html');
    expect(html).toMatch(/id="lot-shipping-field" style="display:none"/);
    expect(html).toMatch(/shipping_allowed === true/);
  });
});

describe('public shipping page makes no blanket shipping promise', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'shipping-available.html'), 'utf8');
  test.each(['Ships Nationwide', 'No local pickup required', 'Nationwide Delivery', 'Buy from Anywhere'])('does not contain "%s"', (s) => {
    expect(html.toLowerCase()).not.toContain(s.toLowerCase());
  });
  test('says shipping depends on the individual listing', () => {
    expect(html).toMatch(/depends on the individual listing/);
    expect(html).toMatch(/shipping details/);
  });
  test('keeps its purpose: shipping-scoped feeds still load', () => {
    expect(html).toMatch(/\/api\/public\/auctions\?shipping=true/);
    expect(html).toMatch(/shippable: 'true'/);
  });
});

describe('POST /api/lots (lot-builder create path) — shippable', () => {
  const post = (user, shippable = true) => {
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO lots/.test(sql)) { captured.lotInsertSql = sql; captured.lotInsert = params; return { rows: [{ id: LID, lot_number: 1, title: 'Vase', shippable: params[10] }] }; }
      return base(sql, params);
    });
    return call(lotsRouter, 'post', '/', { body: { auctionId: AID, title: 'Vase', size_category: 'A', shippable }, user });
  };
  test('Professional Seller: shippable saved', async () => {
    seller = PROFESSIONAL;
    const r = await post(SELLER_USER);
    expect(r.status).toBe(201);
    expect(captured.lotInsertSql).toMatch(/shippable/);
    expect(captured.lotInsert[10]).toBe(true);
  });
  test('Individual Seller: shippable ignored (null → column default false), not an error', async () => {
    seller = INDIVIDUAL;
    const r = await post(SELLER_USER);
    expect(r.status).toBe(201);
    expect(captured.lotInsert[10]).toBeNull();
  });
  test('Individual Seller with capabilities.shipping_enabled: shippable saved', async () => {
    seller = ENABLED_INDIVIDUAL;
    await post(SELLER_USER);
    expect(captured.lotInsert[10]).toBe(true);
  });
  test('Admin: shippable saved even for an Individual Seller auction', async () => {
    seller = INDIVIDUAL;
    await post(ADMIN_USER);
    expect(captured.lotInsert[10]).toBe(true);
  });
  test('allowed seller can explicitly save false', async () => {
    seller = PROFESSIONAL;
    await post(SELLER_USER, false);
    expect(captured.lotInsert[10]).toBe(false);
  });
  test('lot-builder.html sends the toggle value in its create payload', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'lot-builder.html'), 'utf8');
    expect(html).toMatch(/shippable:\s*document\.getElementById\('lot-shippable'\)\.checked/);
  });
});

describe('admin capabilities endpoint — shipping_enabled toggle', () => {
  const adminRouter = require('../src/routes/admin');
  const routePath = '/sellers/:sellerId/capabilities';
  test('admin: merges shipping_enabled into seller_profiles.capabilities and audits before/after', async () => {
    seller = INDIVIDUAL;
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/UPDATE seller_profiles SET capabilities/.test(sql)) { captured.capUpdate = params; return { rows: [{ id: SPID, capabilities: JSON.parse(params[0]) }] }; }
      return base(sql, params);
    });
    const r = await call(adminRouter, 'post', routePath, { params: { sellerId: SPID }, body: { shipping_enabled: true }, user: ADMIN_USER });
    expect(r.status).toBe(200);
    expect(JSON.parse(captured.capUpdate[0])).toEqual({ shipping_enabled: true });
    expect(captured.capUpdate[1]).toBe(SPID);
    const auditCall = db.query.mock.calls.find(([sql, p]) => /audit/i.test(sql) && JSON.stringify(p || []).includes('seller_capabilities_changed'));
    expect(auditCall).toBeTruthy();
    // and back off
    seller = ENABLED_INDIVIDUAL;
    await call(adminRouter, 'post', routePath, { params: { sellerId: SPID }, body: { shipping_enabled: false }, user: ADMIN_USER });
    expect(JSON.parse(captured.capUpdate[0])).toEqual({ shipping_enabled: false });
  });
  test('non-admin refused by the role gate', () => {
    const layer = adminRouter.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.post);
    const roleGate = layer.route.stack[1].handle;
    let status = 200; let nextCalled = false;
    const res = { status(c) { status = c; return res; }, json() { return res; } };
    roleGate({ user: SELLER_USER }, res, () => { nextCalled = true; });
    expect(status).toBe(403);
    expect(nextCalled).toBe(false);
    roleGate({ user: ADMIN_USER }, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
  test('admin moderation page has the shipping toggle wired to the capabilities endpoint', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'moderation.html'), 'utf8');
    expect(html).toMatch(/Shipping enabled for this seller \(Individual Sellers only; Professional Sellers always have shipping\)/);
    expect(html).toMatch(/\/api\/admin\/sellers\/\$\{sellerProfileId\}\/capabilities`, \{ shipping_enabled: enable \}/);
    expect(html).toMatch(/capabilities\.shipping_enabled === true/);
  });
});
