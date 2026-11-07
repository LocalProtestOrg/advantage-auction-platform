'use strict';

/**
 * Per-account bid rate limit on the LIVE bid route (POST /api/lots/:lotId/bids in src/routes/lots.js), exercised
 * through the real router. 20 bids / 10 s and 120 / min per signed-in account; administrators exempt; a clear 429.
 * The limiter only counts requests: bid resolution (proxy bids, soft close) is unchanged and runs in createBid.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-bid-rate-limit';
process.env.BID_RATE_LIMIT_ENABLED = 'true';   // the limiters skip outside production unless this is set
jest.mock('../src/db', () => ({
  query: jest.fn(async (sql) => (/FROM lots l\s+JOIN auctions a/.test(sql)
    ? { rows: [{ state: 'open', closes_at: new Date(Date.now() + 3600e3), auction_id: 'a1', auction_state: 'active', auction_start_time: new Date(Date.now() - 3600e3) }] }
    : { rows: [] })),
  connect: jest.fn(),
}));
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  if (!req.headers['x-user']) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: req.headers['x-user'], role: req.headers['x-role'] || 'buyer' }; next();
});
jest.mock('../src/services/auctionRegistrationService', () => ({ assertCanBid: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/services/bidService', () => {
  const actual = jest.requireActual('../src/services/bidService');
  return { ...actual, createBid: jest.fn(async () => ({ amount_cents: 100, winner_user_id: 'x' })) };
});

const http = require('http');
const express = require('express');
const { createBid } = require('../src/services/bidService');
const limits = require('../src/middleware/rateLimit');

let server, base;
beforeAll(async () => {
  const a = express(); a.use(express.json());
  a.use('/api/lots', require('../src/routes/lots'));
  server = http.createServer(a).listen(0); await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
afterAll(() => { server.close(); delete process.env.BID_RATE_LIMIT_ENABLED; });

const bid = (user, role, lot = 'lot-1') => fetch(base + '/api/lots/' + lot + '/bids', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-user': user, ...(role ? { 'x-role': role } : {}) }, body: JSON.stringify({ amount: 5 }) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), headers: r.headers }));

describe('bid rate limit (per account)', () => {
  test('limits are generous for live bidding: 20 per 10 seconds and 120 per minute', () => {
    expect(limits.BID_LIMITS).toEqual({ burst: { windowMs: 10000, max: 20 }, sustained: { windowMs: 60000, max: 120 } });
  });
  test('the 21st bid inside 10 seconds is refused with a clear 429; other accounts are unaffected', async () => {
    createBid.mockClear();
    for (let i = 0; i < 20; i++) {
      const r = await bid('user-a', null, i % 2 ? 'lot-1' : 'lot-2');   // counted per account across lots
      expect(r.status).toBe(200);
    }
    const over = await bid('user-a');
    expect(over.status).toBe(429);
    expect(over.json).toEqual({ success: false, code: 'BID_RATE_LIMITED', message: limits.BID_RATE_MESSAGE });
    expect(createBid).toHaveBeenCalledTimes(20);   // the refused request never reached bid placement
    expect((await bid('user-b')).status).toBe(200);
  });
  test('administrators are exempt', async () => {
    for (let i = 0; i < 25; i++) expect((await bid('admin-1', 'admin')).status).toBe(200);
  });
  test('ON in production, skipped in test/development unless enabled, emergency off switch, admins always skipped', () => {
    const save = { env: process.env.NODE_ENV, flag: process.env.BID_RATE_LIMIT_ENABLED };
    const buyer = { user: { id: 'u', role: 'buyer' } }; const admin = { user: { id: 'a', role: 'admin' } };
    try {
      process.env.NODE_ENV = 'production'; delete process.env.BID_RATE_LIMIT_ENABLED;
      expect(limits.bidLimitSkipped(buyer)).toBe(false);
      expect(limits.bidLimitSkipped(admin)).toBe(true);
      process.env.BID_RATE_LIMIT_ENABLED = 'false';
      expect(limits.bidLimitSkipped(buyer)).toBe(true);
      process.env.NODE_ENV = 'test'; delete process.env.BID_RATE_LIMIT_ENABLED;
      expect(limits.bidLimitSkipped(buyer)).toBe(true);
      process.env.BID_RATE_LIMIT_ENABLED = 'true';
      expect(limits.bidLimitSkipped(buyer)).toBe(false);
    } finally { process.env.NODE_ENV = save.env; process.env.BID_RATE_LIMIT_ENABLED = save.flag; }
  });
  test('the live route applies the limiter after authentication (so the key is the account)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'lots.js'), 'utf8');
    expect(src).toMatch(/router\.post\('\/:lotId\/bids', authMiddleware, \.\.\.bidRateLimit, async/);
  });
});
