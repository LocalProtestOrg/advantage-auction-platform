'use strict';

/**
 * Controlled checkout pilot (Release 2 preparation, 2026-11-03). While MARKETPLACE_CHECKOUT_ENABLED is off, storefront
 * checkout works only for a seller company in MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS AND a signed-in buyer in
 * MARKETPLACE_CHECKOUT_PILOT_USER_IDS. Unset (the default) = checkout off for everyone, exactly as before.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-checkout-pilot'; // test value, never a real secret
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');
const G = require('../src/lib/launchGuards');

const SELLER = '11111111-1111-4111-8111-111111111111';
const OTHER_SELLER = '22222222-2222-4222-8222-222222222222';
const BUYER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const PILOT = { MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS: SELLER, MARKETPLACE_CHECKOUT_PILOT_USER_IDS: BUYER + ', ' + BUYER.toUpperCase() };
const KEYS = ['MARKETPLACE_CHECKOUT_ENABLED', 'MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS', 'MARKETPLACE_CHECKOUT_PILOT_USER_IDS'];
const saved = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } db.query.mockReset(); });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('the switch', () => {
  test('default (nothing set): checkout is off for everyone, background work idle', () => {
    expect(G.marketplaceCheckoutActive({})).toBe(false);
    expect(G.marketplaceCheckoutAllowed({ sellerId: SELLER, userId: BUYER }, {})).toBe(false);
    expect(G.marketplaceCheckoutShownTo(BUYER, {})).toBe(false);
  });
  test('pilot: only a listed buyer buying from a listed seller; never a signed-out visitor', () => {
    expect(G.marketplaceCheckoutActive(PILOT)).toBe(true);
    expect(G.marketplaceCheckoutAllowed({ sellerId: SELLER, userId: BUYER }, PILOT)).toBe(true);
    expect(G.marketplaceCheckoutAllowed({ sellerId: SELLER.toUpperCase(), userId: BUYER }, PILOT)).toBe(true);
    expect(G.marketplaceCheckoutAllowed({ sellerId: SELLER, userId: STRANGER }, PILOT)).toBe(false);
    expect(G.marketplaceCheckoutAllowed({ sellerId: OTHER_SELLER, userId: BUYER }, PILOT)).toBe(false);
    expect(G.marketplaceCheckoutAllowed({ sellerId: SELLER, userId: null }, PILOT)).toBe(false);
    expect(G.marketplaceCheckoutShownTo(BUYER, PILOT)).toBe(true);
    expect(G.marketplaceCheckoutShownTo(STRANGER, PILOT)).toBe(false);
    expect(G.marketplaceCheckoutShownTo(null, PILOT)).toBe(false);
  });
  test('a pilot needs BOTH lists; malformed ids are ignored', () => {
    expect(G.marketplaceCheckoutActive({ MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS: SELLER })).toBe(false);
    expect(G.marketplaceCheckoutActive({ MARKETPLACE_CHECKOUT_PILOT_USER_IDS: BUYER })).toBe(false);
    expect(G.marketplaceCheckoutActive({ MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS: 'everyone', MARKETPLACE_CHECKOUT_PILOT_USER_IDS: '*' })).toBe(false);
  });
  test('the general switch still opens checkout for everyone', () => {
    const on = { MARKETPLACE_CHECKOUT_ENABLED: 'true' };
    expect(G.marketplaceCheckoutAllowed({ sellerId: OTHER_SELLER, userId: STRANGER }, on)).toBe(true);
    expect(G.marketplaceCheckoutShownTo(null, on)).toBe(true);
  });
});

describe('every checkout step refuses anyone outside the pilot with the same answer', () => {
  const svc = require('../src/services/marketplaceOrderService');
  const itemOf = (sellerId) => db.query.mockImplementation(async (sql) => (/SELECT seller_id FROM marketplace_items/.test(sql) ? { rows: [{ seller_id: sellerId }] } : { rows: [] }));
  test('switch off and no pilot: quote, order and payment are refused before anything is read', async () => {
    for (const p of [svc.quote('i-1', BUYER), svc.createOrder('i-1', BUYER, { policiesAcknowledged: true }), svc.payOrder('00000000-0000-4000-8000-000000000001', BUYER)]) {
      await expect(p).rejects.toMatchObject({ status: 403, code: 'CHECKOUT_DISABLED' });
    }
    expect(db.query).not.toHaveBeenCalled();
  });
  test('pilot: a buyer not on the list, or an item of a seller not on the list, is refused', async () => {
    Object.assign(process.env, PILOT);
    itemOf(SELLER);
    await expect(svc.quote('i-1', STRANGER)).rejects.toMatchObject({ code: 'CHECKOUT_DISABLED' });
    await expect(svc.createOrder('i-1', STRANGER, { policiesAcknowledged: true })).rejects.toMatchObject({ code: 'CHECKOUT_DISABLED' });
    itemOf(OTHER_SELLER);
    await expect(svc.quote('i-1', BUYER)).rejects.toMatchObject({ code: 'CHECKOUT_DISABLED' });
    await expect(svc.createOrder('i-1', BUYER, { policiesAcknowledged: true })).rejects.toMatchObject({ code: 'CHECKOUT_DISABLED' });
    // payment of an order whose seller is not in the pilot
    db.query.mockImplementation(async () => ({ rows: [{ id: 'o-1', seller_id: OTHER_SELLER, buyer_user_id: BUYER }] }));
    await expect(svc.payOrder('00000000-0000-4000-8000-000000000001', BUYER)).rejects.toMatchObject({ code: 'CHECKOUT_DISABLED' });
  });
  test('pilot: a listed buyer and seller pass the checkout gate (and reach the normal purchase checks)', async () => {
    Object.assign(process.env, PILOT);
    itemOf(SELLER);
    const e = await svc.quote('i-1', BUYER).catch((x) => x);
    expect(e.code).not.toBe('CHECKOUT_DISABLED');   // the next check (the item itself) answers instead
  });
});

describe('the public config tells only a signed-in pilot buyer that checkout is on', () => {
  const express = require('express');
  let server, base;
  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../src/middleware/optionalAuthMiddleware', () => (req, res, next) => { const u = req.get('x-test-user'); if (u) req.user = { id: u }; next(); });
    const app = express(); app.use('/api/marketplace', require('../src/routes/marketplaceOrders'));
    await new Promise((r) => { server = app.listen(0, r); }); base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(async () => { if (server) await new Promise((r) => server.close(r)); jest.dontMock('../src/middleware/optionalAuthMiddleware'); });
  const cfg = async (user) => (await (await fetch(base + '/api/marketplace/config', { headers: user ? { 'x-test-user': user } : {} })).json()).data.checkout_enabled;
  test('off by default; with the pilot set, on only for the pilot buyer', async () => {
    expect(await cfg(null)).toBe(false);
    expect(await cfg(BUYER)).toBe(false);
    Object.assign(process.env, PILOT);
    expect(await cfg(null)).toBe(false);
    expect(await cfg(STRANGER)).toBe(false);
    expect(await cfg(BUYER)).toBe(true);
  });
});
