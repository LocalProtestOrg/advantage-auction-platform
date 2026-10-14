'use strict';

/**
 * Regression: the individual "$39 Estate Sale Promotion" is DISABLED (owner decision 2026-10-12 —
 * never owner-approved, zero production purchases). Purchase must be refused server-side regardless
 * of configuration, the customer pages must not be served, and nothing under public/ may advertise it.
 * Historical data + webhook handling stay intact (covered in tests/estate-sale-promotion.test.js).
 * No real Stripe/DB/network.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Isolate the router from auth/DB/rate-limit infrastructure.
jest.mock('../src/middleware/authMiddleware', () => (req, _res, next) => { req.user = { id: 'u-test' }; next(); });
jest.mock('../src/middleware/rateLimit', () => ({
  strictLimiter: (_q, _s, n) => n(), normalLimiter: (_q, _s, n) => n(), feedbackLimiter: (_q, _s, n) => n(),
}));
jest.mock('../src/middleware/idempotency', () => (_q, _s, n) => n());
jest.mock('../src/services/estateSalePromotionService', () => ({
  statusForUser: jest.fn(async () => ({ has_available: false, estate_sales: [] })),
  createCheckoutSession: jest.fn(async () => ({ url: 'https://checkout.example/should-not-happen', id: 'cs_x' })),
  createEstateSale: jest.fn(async () => ({ id: 'e1' })),
  submitEstateSale: jest.fn(async () => ({ id: 'e1' })),
}));

const guards = require('../src/lib/launchGuards');
const svcMock = require('../src/services/estateSalePromotionService');
const router = require('../src/routes/estateSale');

function handlerFor(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not found: ' + method + ' ' + routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}
const fakeReq = (extra = {}) => ({ user: { id: 'u-test' }, headers: {}, params: {}, body: {}, protocol: 'https', get: () => 'bid.advantage.bid', ...extra });

describe('flag', () => {
  test('ESTATE_SALE_PROMOTION_ENABLED is a hard false constant', () => {
    expect(guards.ESTATE_SALE_PROMOTION_ENABLED).toBe(false);
    expect(guards.estateSalePromotionEnabled()).toBe(false);
  });
});

describe('server-side refusal regardless of configuration', () => {
  const prev = process.env.STRIPE_ESTATE_SALE_PRICE_ID;
  beforeAll(() => { process.env.STRIPE_ESTATE_SALE_PRICE_ID = 'price_configured_test'; });
  afterAll(() => { if (prev === undefined) delete process.env.STRIPE_ESTATE_SALE_PRICE_ID; else process.env.STRIPE_ESTATE_SALE_PRICE_ID = prev; });
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['post', '/checkout-session', {}],
    ['post', '/events', { body: { title: 'x' } }],
    ['post', '/events/:id/submit', { params: { id: 'e1' } }],
  ])('%s %s → 410 NOT_AVAILABLE even with STRIPE_ESTATE_SALE_PRICE_ID set', async (method, p, extra) => {
    const res = fakeRes();
    await handlerFor(method, p)(fakeReq(extra), res);
    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({ success: false, error: 'NOT_AVAILABLE', message: 'This offering is not available.' });
    expect(svcMock.createCheckoutSession).not.toHaveBeenCalled();
    expect(svcMock.createEstateSale).not.toHaveBeenCalled();
    expect(svcMock.submitEstateSale).not.toHaveBeenCalled();
  });

  test('GET /promotion stays readable for historical records', async () => {
    const res = fakeRes();
    await handlerFor('get', '/promotion')(fakeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('the service itself refuses to create a Stripe session (defense in depth)', async () => {
    const realSvc = jest.requireActual('../src/services/estateSalePromotionService');
    await expect(realSvc.createCheckoutSession('u-test', 'https://bid.advantage.bid'))
      .rejects.toMatchObject({ status: 410, code: 'NOT_AVAILABLE' });
  });

  test('webhook routing for historical sessions is kept intact', () => {
    const pay = fs.readFileSync(path.join(ROOT, 'src', 'services', 'paymentService.js'), 'utf8');
    expect(pay).toMatch(/productType === 'estate_sale_promotion'\) return require\('\.\/estateSalePromotionService'\)\.handleCheckoutCompleted/);
  });
});

describe('no customer availability or advertisement', () => {
  test('the customer pages are not served from public/', () => {
    ['promote-estate-sale', 'estate-sale-welcome', 'create-estate-sale', 'my-estate-sales'].forEach((n) => {
      expect(fs.existsSync(path.join(ROOT, 'public', n + '.html'))).toBe(false);
    });
  });

  test('no file under public/ advertises it', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const files = walk(path.join(ROOT, 'public')).filter((f) => /\.(html?|js|css|json|txt|xml)$/i.test(f));
    const offenders = [];
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      if (/promote-estate-sale|Estate Sale Promotion|estate_sale_promotion|\/api\/estate-sale\b|\$39\b/i.test(t)) offenders.push(path.relative(ROOT, f));
    }
    expect(offenders).toEqual([]);
  });

  test('no page-intent or sales-outreach entry points to the archived pages', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'pageIntentRegistry.js'), 'utf8')).not.toMatch(/promote-estate-sale|create-estate-sale/);
    expect(fs.readFileSync(path.join(ROOT, 'src', 'services', 'salesOutreachTemplates.js'), 'utf8')).not.toMatch(/create-estate-sale/);
  });
});
