'use strict';

/**
 * Security regression (2026-09-27): GET /api/auctions/:id/report and /report/pdf returned any auction's report
 * (winning buyers' emails, per-lot money, seller net) to ANY logged-in user. Access is now limited to the
 * auction's own seller, a Super Admin, or active staff holding finance.view — decided server-side from the
 * authenticated user id and the database. Everyone else gets the same 404 as a missing auction.
 * Synthetic ids only; no customer data.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-report-authz';
const http = require('http');

const AUCTION = '11111111-1111-4111-8111-111111111111';
const USERS = {
  owner:         { id: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'seller' },
  otherSeller:   { id: 'aaaaaaaa-0000-4000-8000-000000000002', role: 'seller' },
  buyer:         { id: 'aaaaaaaa-0000-4000-8000-000000000003', role: 'buyer' },
  admin:         { id: 'aaaaaaaa-0000-4000-8000-000000000004', role: 'admin' },
  finance:       { id: 'aaaaaaaa-0000-4000-8000-000000000005', role: 'seller', staff_role: 'finance', staff_active: true },
  financeOff:    { id: 'aaaaaaaa-0000-4000-8000-000000000006', role: 'seller', staff_role: 'finance', staff_active: false },
  financeDenied: { id: 'aaaaaaaa-0000-4000-8000-000000000007', role: 'seller', staff_role: 'finance', staff_active: true,
    overrides: [{ permission: 'finance.view', effect: 'deny' }] },
  marketing:     { id: 'aaaaaaaa-0000-4000-8000-000000000008', role: 'seller', staff_role: 'marketing', staff_active: true },
  superStaff:    { id: 'aaaaaaaa-0000-4000-8000-000000000009', role: 'buyer', staff_role: 'super_admin', staff_active: true },
};
const byId = Object.fromEntries(Object.values(USERS).map((u) => [u.id, u]));

jest.mock('../src/db', () => {
  const query = jest.fn();
  return { query, connect: async () => ({ query, release() {} }) };
});
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const id = req.headers['x-test-user'];
  if (!id) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id, role: req.headers['x-test-role'] };   // what the token claims; staff data comes from the db
  next();
});
jest.mock('../src/services/reportingService', () => ({ generateAuctionReport: jest.fn(async () => ({ lots: [], totals: {} })) }));
jest.mock('../src/services/pdfGenerationService', () => ({ buildReportPdf: jest.fn(async () => ({ buffer: Buffer.from('%PDF-1.4 test') })) }));

const db = require('../src/db');
const { generateAuctionReport } = require('../src/services/reportingService');
const { buildReportPdf } = require('../src/services/pdfGenerationService');

db.query.mockImplementation(async (sql, params) => {
  const s = String(sql);
  if (/FROM users WHERE id = \$1/.test(s)) {
    const u = byId[params[0]];
    return { rows: u ? [{ id: u.id, role: u.role, staff_role: u.staff_role || null, staff_active: u.staff_active !== false }] : [] };
  }
  if (/FROM staff_permission_overrides/.test(s)) return { rows: (byId[params[0]] && byId[params[0]].overrides) || [] };
  if (/FROM auctions a JOIN seller_profiles sp ON sp.id = a.seller_id/.test(s)) {
    return { rows: params[0] === AUCTION && params[1] === USERS.owner.id ? [{ '?column?': 1 }] : [] };
  }
  return { rows: [] };
});

let server; let base;
beforeAll(async () => {
  const express = require('express');
  const app = express();
  app.use('/api/auctions', require('../src/routes/auctions'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port + '/api/auctions/';
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { generateAuctionReport.mockClear(); buildReportPdf.mockClear(); });

const get = (path, user) => fetch(base + path, { headers: user ? { 'x-test-user': user.id, 'x-test-role': user.role } : {} });
const both = ['report', 'report/pdf'];

describe('auction report access', () => {
  test.each(both)('an unrelated logged-in BUYER cannot read another seller\'s %s', async (p) => {
    const res = await get(AUCTION + '/' + p, USERS.buyer);
    expect(res.status).toBe(404);
    expect(generateAuctionReport).not.toHaveBeenCalled();
    expect(buildReportPdf).not.toHaveBeenCalled();
  });
  test.each(both)('an unrelated logged-in SELLER cannot read another seller\'s %s', async (p) => {
    expect((await get(AUCTION + '/' + p, USERS.otherSeller)).status).toBe(404);
    expect(generateAuctionReport).not.toHaveBeenCalled();
    expect(buildReportPdf).not.toHaveBeenCalled();
  });
  test.each(both)('a token claiming role=admin is not trusted: admin status comes from the database (%s)', async (p) => {
    const res = await fetch(base + AUCTION + '/' + p, { headers: { 'x-test-user': USERS.buyer.id, 'x-test-role': 'admin' } });
    expect(res.status).toBe(404);
  });
  test.each(both)('the auction\'s own seller can read the %s', async (p) => {
    expect((await get(AUCTION + '/' + p, USERS.owner)).status).toBe(200);
  });
  test.each(both)('an admin can read the %s', async (p) => {
    expect((await get(AUCTION + '/' + p, USERS.admin)).status).toBe(200);
  });
  test.each(both)('a staff Super Admin can read the %s', async (p) => {
    expect((await get(AUCTION + '/' + p, USERS.superStaff)).status).toBe(200);
  });
  test.each(both)('active Finance staff can read the %s', async (p) => {
    expect((await get(AUCTION + '/' + p, USERS.finance)).status).toBe(200);
  });
  test.each(both)('deactivated Finance staff, Finance staff with finance.view denied, and Marketing staff cannot (%s)', async (p) => {
    for (const u of [USERS.financeOff, USERS.financeDenied, USERS.marketing]) {
      expect([u.id, (await get(AUCTION + '/' + p, u)).status]).toEqual([u.id, 404]);
    }
  });
  test.each(both)('an unknown auction id looks exactly like a forbidden one (%s)', async (p) => {
    const unknown = '22222222-2222-4222-8222-222222222222';
    const a = await get(unknown + '/' + p, USERS.otherSeller);
    const b = await get(AUCTION + '/' + p, USERS.otherSeller);
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });
  test.each(both)('not logged in → 401 (%s)', async (p) => {
    expect((await get(AUCTION + '/' + p, null)).status).toBe(401);
  });
  test('the ownership check uses the authenticated user id and the path auction id', async () => {
    db.query.mockClear();   // keeps the implementation; forgets earlier tests' calls
    await get(AUCTION + '/report', USERS.otherSeller);
    const call = db.query.mock.calls.find(([sql]) => /FROM auctions a JOIN seller_profiles/.test(sql));
    expect(call[1]).toEqual([AUCTION, USERS.otherSeller.id]);
  });
});
