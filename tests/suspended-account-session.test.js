'use strict';

// Suspended-account enforcement for ALREADY-AUTHENTICATED sessions.
// Suspension = users.is_active = false (mig 046). Login / registration / bidding services already refuse
// inactive accounts, but a JWT issued while the account was active stays valid until it expires. The auth
// middleware now re-checks account status (src/lib/accountStatus.js) and refuses every state-changing
// request from a suspended account with 403 ACCOUNT_SUSPENDED, and stops renewing its session.
// Real routers + the real authMiddleware are mounted on an ephemeral Express server; the db and the
// downstream services are mocked so we can prove the handler never runs for a suspended account.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-suspended-session';

const mockAccounts = new Map(); // userId -> is_active
const mockDb = { statusDown: false }; // simulate a database outage for the status lookup only
jest.mock('../src/db', () => ({
  query: jest.fn(async (sql, params) => {
    // Legacy status lookup, or the per-request session check (src/lib/sessionTokens.js) that replaced it.
    if (/SELECT is_active FROM users WHERE id = \$1|FROM users u WHERE u\.id = \$1/.test(sql)) {
      if (mockDb.statusDown) throw new Error('connection terminated unexpectedly');
      const id = params && params[0];
      return { rows: mockAccounts.has(id) ? [{ is_active: mockAccounts.get(id) }] : [] };
    }
    return { rows: [] };
  }),
  connect: jest.fn(),
}));
jest.mock('../src/services/bidService', () => ({ createBid: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/services/marketplaceOrderService', () => new Proxy({}, {
  get: (t, k) => { if (!t[k]) t[k] = jest.fn(async () => ({ ok: true })); return t[k]; },
}));
jest.mock('../src/services/marketplaceItemService', () => new Proxy({}, {
  get: (t, k) => { if (!t[k]) t[k] = jest.fn(async () => ({ id: 's1' })); return t[k]; },
}));
jest.mock('../src/services/storefrontService', () => new Proxy({}, {
  get: (t, k) => { if (!t[k]) t[k] = jest.fn(async () => ({ ok: true })); return t[k]; },
}));
jest.mock('../src/services/paymentService', () => new Proxy({}, {
  get: (t, k) => { if (!t[k]) t[k] = jest.fn(async () => ({ ok: true })); return t[k]; },
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const bidService = require('../src/services/bidService');
const orders = require('../src/services/marketplaceOrderService');
const items = require('../src/services/marketplaceItemService');
const paymentService = require('../src/services/paymentService');
const accountStatus = require('../src/lib/accountStatus');

const SECRET = process.env.JWT_SECRET;
const now = () => Math.floor(Date.now() / 1000);
// Token minted while the account was active (fresh, or past half-life to exercise renewal).
const tokenFor = (id, role, { aged } = {}) => jwt.sign(
  aged ? { id, role, iat: now() - 50000, exp: now() + 30000 } : { id, role }, SECRET, aged ? undefined : { expiresIn: '24h' });

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/lots', require('../src/routes/bids'));
  app.use('/api/marketplace', require('../src/routes/marketplaceOrders'));
  app.use('/api/seller-storefront', require('../src/routes/sellerStorefront'));
  app.use('/api/payments', require('../src/routes/payments'));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { mockDb.statusDown = false; mockAccounts.clear(); accountStatus._clearAccountStatusCache(); jest.clearAllMocks(); });

const call = (method, path, token, body) => fetch(base + path, {
  method,
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: body ? JSON.stringify(body) : undefined,
});

// Issue the session while active, then suspend — the token itself stays cryptographically valid.
function suspendedSession(id, role, opts) {
  mockAccounts.set(id, true);
  const t = tokenFor(id, role, opts);
  mockAccounts.set(id, false);
  return t;
}

async function expectSuspended(resp) {
  expect(resp.status).toBe(403);
  const body = await resp.json();
  expect(body.success).toBe(false);
  expect(body.code).toBe('ACCOUNT_SUSPENDED');
  expect(body.message).toBe('This account is suspended. Please contact Advantage.Bid support.');
  expect(resp.headers.get('x-refreshed-token')).toBeNull();
  // The message never reveals how the check works.
  expect(JSON.stringify(body)).not.toMatch(/is_active|cache|token/i);
}

describe('suspended account with a still-valid session', () => {
  test('bidding is refused with 403 ACCOUNT_SUSPENDED; bid service never runs', async () => {
    const t = suspendedSession('buyer-1', 'buyer');
    await expectSuspended(await call('POST', '/api/lots/lot-1/bids', t, { amount: 10 }));
    expect(bidService.createBid).not.toHaveBeenCalled();
  });

  test('storefront / marketplace checkout is refused', async () => {
    const t = suspendedSession('buyer-2', 'buyer');
    await expectSuspended(await call('POST', '/api/marketplace/orders', t, { item_id: 'i1' }));
    await expectSuspended(await call('POST', '/api/marketplace/orders/o1/pay', t, {}));
    for (const fn of Object.keys(orders)) expect(orders[fn]).not.toHaveBeenCalled();
  });

  test('payment actions are refused (charge, card on file)', async () => {
    const t = suspendedSession('buyer-3', 'buyer');
    await expectSuspended(await call('POST', '/api/payments/charge-lot', t, { lotId: 'l1' }));
    await expectSuspended(await call('POST', '/api/payments/card-on-file', t, {}));
    for (const fn of Object.keys(paymentService)) expect(paymentService[fn]).not.toHaveBeenCalled();
  });

  test('seller selling-activity creation is refused (storefront item create, config update)', async () => {
    const t = suspendedSession('seller-1', 'seller');
    await expectSuspended(await call('POST', '/api/seller-storefront/items', t, { title: 'Lamp' }));
    await expectSuspended(await call('PUT', '/api/seller-storefront/config', t, {}));
    expect(items.createDirectListing).not.toHaveBeenCalled();
  });

  test('a suspended ADMIN account is refused as well (no admin exemption for its own suspension)', async () => {
    const t = suspendedSession('admin-1', 'admin');
    await expectSuspended(await call('POST', '/api/marketplace/admin/orders/o1/refund', t, {}));
  });

  test('GET reads behave as before (200), but a suspended session is NOT renewed', async () => {
    const t = suspendedSession('seller-2', 'seller', { aged: true }); // past half-life → would normally renew
    const r = await call('GET', '/api/seller-storefront/items', t);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-refreshed-token')).toBeNull();
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  test('suspension takes effect immediately on this instance after an admin invalidates the status', async () => {
    mockAccounts.set('buyer-4', true);
    const t = tokenFor('buyer-4', 'buyer');
    expect((await call('POST', '/api/lots/lot-1/bids', t, { amount: 5 })).status).toBe(200);
    mockAccounts.set('buyer-4', false);
    accountStatus.invalidateAccountStatus('buyer-4');
    await expectSuspended(await call('POST', '/api/lots/lot-1/bids', t, { amount: 6 }));
  });
});

describe('active accounts are unaffected', () => {
  test('active buyer can bid and check out', async () => {
    mockAccounts.set('buyer-5', true);
    const t = tokenFor('buyer-5', 'buyer');
    const r = await call('POST', '/api/lots/lot-1/bids', t, { amount: 10 });
    expect(r.status).toBe(200);
    expect(bidService.createBid).toHaveBeenCalledTimes(1);
    const o = await call('POST', '/api/marketplace/orders', t, { item_id: 'i1' });
    expect(o.status).not.toBe(403);
  });

  test('active seller can create a storefront item', async () => {
    mockAccounts.set('seller-3', true);
    const r = await call('POST', '/api/seller-storefront/items', tokenFor('seller-3', 'seller'), { title: 'Lamp' });
    expect(r.status).toBe(201);
    expect(items.createDirectListing).toHaveBeenCalledTimes(1);
  });

  test('active session past half-life is still renewed', async () => {
    mockAccounts.set('buyer-6', true);
    const r = await call('GET', '/api/seller-storefront/items', tokenFor('buyer-6', 'buyer', { aged: true }));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-refreshed-token')).toBeTruthy();
  });

});

describe('account status cannot be determined — fail closed for state changes only', () => {
  async function expectUnavailable(resp) {
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('ACCOUNT_STATUS_UNAVAILABLE');
    expect(body.error).toBe('ACCOUNT_STATUS_UNAVAILABLE');
    expect(body.message).toBe('We could not complete this request right now. Please try again shortly.');
    expect(resp.headers.get('x-refreshed-token')).toBeNull();
    // Neutral: never claims suspension, never reveals how the check works.
    expect(JSON.stringify(body)).not.toMatch(/suspend|is_active|cache|token|database/i);
  }

  test('DB error during status lookup → POST / PUT / DELETE refused 503; handlers never run', async () => {
    mockAccounts.set('buyer-7', true);
    const t = tokenFor('buyer-7', 'buyer');
    mockDb.statusDown = true;
    await expectUnavailable(await call('POST', '/api/lots/lot-1/bids', t, { amount: 10 }));
    await expectUnavailable(await call('POST', '/api/marketplace/orders', t, { item_id: 'i1' }));
    await expectUnavailable(await call('PUT', '/api/seller-storefront/config', t, {}));
    await expectUnavailable(await call('DELETE', '/api/seller-storefront/items/s1', t));
    await expectUnavailable(await call('POST', '/api/payments/card-on-file', t, {}));
    expect(bidService.createBid).not.toHaveBeenCalled();
    for (const fn of Object.keys(orders)) expect(orders[fn]).not.toHaveBeenCalled();
    for (const fn of Object.keys(paymentService)) expect(paymentService[fn]).not.toHaveBeenCalled();
  });

  test('GET still succeeds under the same DB error (fresh and renewal-due sessions; no renewal while unknown)', async () => {
    mockAccounts.set('buyer-8', true);
    mockDb.statusDown = true;
    expect((await call('GET', '/api/seller-storefront/items', tokenFor('buyer-8', 'buyer'))).status).toBe(200);
    const r = await call('GET', '/api/seller-storefront/items', tokenFor('buyer-8', 'buyer', { aged: true }));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-refreshed-token')).toBeNull();
  });

  test('missing user row for an authenticated id → 503 for state-changing, GET unaffected', async () => {
    const t = tokenFor('ghost', 'buyer');
    await expectUnavailable(await call('POST', '/api/lots/lot-1/bids', t, { amount: 1 }));
    await expectUnavailable(await call('DELETE', '/api/seller-storefront/items/s1', t));
    expect(bidService.createBid).not.toHaveBeenCalled();
    expect((await call('GET', '/api/seller-storefront/items', t)).status).toBe(200);
  });

  test('a suspended account is still 403 ACCOUNT_SUSPENDED (not 503)', async () => {
    const t = suspendedSession('buyer-9', 'buyer');
    await expectSuspended(await call('POST', '/api/lots/lot-1/bids', t, { amount: 3 }));
  });

  test('active user is unaffected when the lookup works', async () => {
    mockAccounts.set('buyer-10', true);
    expect((await call('POST', '/api/lots/lot-1/bids', tokenFor('buyer-10', 'buyer'), { amount: 4 })).status).toBe(200);
  });

  test('failed lookup is not cached as active; once the DB recovers the request is allowed again', async () => {
    mockAccounts.set('buyer-11', true);
    const t = tokenFor('buyer-11', 'buyer');
    mockDb.statusDown = true;
    await expectUnavailable(await call('POST', '/api/lots/lot-1/bids', t, { amount: 5 }));
    expect(accountStatus.cachedActive('buyer-11')).toBeUndefined();
    mockDb.statusDown = false;
    expect((await call('POST', '/api/lots/lot-1/bids', t, { amount: 6 })).status).toBe(200);
    expect(bidService.createBid).toHaveBeenCalledTimes(1);
    // And a recovered lookup for a SUSPENDED account is a definitive 403, not a stale pass.
    mockAccounts.set('buyer-11', false);
    accountStatus.invalidateAccountStatus('buyer-11');
    await expectSuspended(await call('POST', '/api/lots/lot-1/bids', t, { amount: 7 }));
  });

  test('optional-session state change (signed-in claim completion) applies the same rule', async () => {
    const mw = accountStatus.refuseInactiveSignedIn;
    const run = (user) => new Promise((resolve) => {
      const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
      mw({ user }, res, () => resolve({ next: true }));
    });
    expect(await run(undefined)).toEqual({ next: true }); // anonymous claim unaffected
    mockAccounts.set('u-ok', true);
    expect(await run({ id: 'u-ok', role: 'buyer' })).toEqual({ next: true });
    mockAccounts.set('u-sus', false);
    expect((await run({ id: 'u-sus', role: 'buyer' })).code).toBe(403);
    expect((await run({ id: 'u-none', role: 'buyer' })).code).toBe(503);
    mockDb.statusDown = true;
    const r = await run({ id: 'u-down', role: 'buyer' });
    expect(r.code).toBe(503);
    expect(r.body.code).toBe('ACCOUNT_STATUS_UNAVAILABLE');
  });
});
