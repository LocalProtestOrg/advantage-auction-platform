'use strict';

/**
 * Owner rule (2026-09-28): a draft / submitted / under-review auction must not be retrievable just because someone has
 * its id. The public read endpoints (auction summary, its lot catalog, a single lot) serve such an auction only to its
 * own seller, an admin or active staff (preview); everyone else gets the same 404 as a missing auction.
 * Published / active / closed auctions stay public exactly as before.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));

const db = require('../src/db');
const auctionsRouter = require('../src/routes/auctions');
const lotsRouter = require('../src/routes/lots');
const { canViewAuction, PUBLIC_AUCTION_STATES } = require('../src/lib/auctionVisibility');

const AID = '11111111-1111-4111-8111-111111111111';
const LID = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner-user';

function handlerFor(router, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.get);
  const st = layer.route.stack; return st[st.length - 1].handle;
}
async function call(router, routePath, params, user) {
  let status = 200, body = null;
  const res = { set() { return res; }, status(c) { status = c; return res; }, json(b) { body = b; return res; } };
  await handlerFor(router, routePath)({ params, query: {}, headers: {}, user }, res, (e) => { if (e) throw e; });
  return { status, body };
}
let auctionState = 'draft';
let staffRow = null;
beforeEach(() => {
  jest.clearAllMocks(); auctionState = 'draft'; staffRow = null;
  db.query.mockImplementation(async (sql) => {
    if (/SELECT id, role, staff_role, staff_active FROM users/.test(sql)) return { rows: staffRow ? [staffRow] : [] };
    if (/staff_permission_overrides/.test(sql)) return { rows: [] };
    if (/FROM auctions a\s+LEFT JOIN seller_followers/.test(sql)) {
      return { rows: [{ id: AID, title: 'Draft Estate', state: auctionState, city: 'Austin', address_state: 'TX', owner_user_id: OWNER,
        seller_type: 'estate_sale_company', show_branding_to_buyers: true }] };
    }
    if (/SELECT a\.is_archived, a\.state, sp\.user_id AS owner_user_id/.test(sql)) return { rows: [{ is_archived: false, state: auctionState, owner_user_id: OWNER }] };
    if (/FROM lots\s+WHERE id = \$1/.test(sql)) {
      return { rows: [{ id: LID, auction_id: AID, title: 'Chair', state: 'open', starting_bid_cents: 100, current_bid_cents: 0,
        auction_state: auctionState, auction_owner_user_id: OWNER }] };
    }
    return { rows: [] };
  });
});

const ROUTES = [
  ['summary', auctionsRouter, '/:auctionId/summary', { auctionId: AID }],
  ['lot catalog', lotsRouter, '/auction/:auctionId', { auctionId: AID }],
  ['single lot', lotsRouter, '/:lotId', { lotId: LID }],
];

describe.each(ROUTES)('%s', (_name, router, routePath, params) => {
  test.each(['draft', 'submitted', 'under_review'])('%s auction: anonymous → 404 (same as missing)', async (st) => {
    auctionState = st;
    const r = await call(router, routePath, params, undefined);
    expect(r.status).toBe(404);
  });
  test('draft: another signed-in buyer → 404', async () => {
    expect((await call(router, routePath, params, { id: 'someone-else', role: 'buyer' })).status).toBe(404);
  });
  test('draft: the auction\'s own seller can preview', async () => {
    expect((await call(router, routePath, params, { id: OWNER, role: 'seller' })).status).toBe(200);
  });
  test('draft: an admin can preview', async () => {
    expect((await call(router, routePath, params, { id: 'admin-1', role: 'admin' })).status).toBe(200);
  });
  test('draft: active staff can preview (moderation); inactive staff cannot', async () => {
    staffRow = { id: 'staff-1', role: 'buyer', staff_role: 'moderator', staff_active: true };
    expect((await call(router, routePath, params, { id: 'staff-1', role: 'buyer' })).status).toBe(200);
    staffRow = { id: 'staff-1', role: 'buyer', staff_role: 'moderator', staff_active: false };
    expect((await call(router, routePath, params, { id: 'staff-1', role: 'buyer' })).status).toBe(404);
  });
  test.each(['published', 'active', 'closed'])('%s auction: still public to anonymous visitors', async (st) => {
    auctionState = st;
    expect((await call(router, routePath, params, undefined)).status).toBe(200);
  });
});

test('internal access fields never reach the response', async () => {
  auctionState = 'published';
  const s = await call(auctionsRouter, '/:auctionId/summary', { auctionId: AID }, undefined);
  expect(s.body.data).not.toHaveProperty('owner_user_id');
  const l = await call(lotsRouter, '/:lotId', { lotId: LID }, undefined);
  expect(l.body.data || l.body).not.toHaveProperty('auction_owner_user_id');
  expect(JSON.stringify(l.body)).not.toMatch(/auction_state|owner-user/);
});

test('the rule itself', async () => {
  expect(PUBLIC_AUCTION_STATES).toEqual(['published', 'active', 'closed']);
  await expect(canViewAuction({}, { state: 'draft', ownerUserId: OWNER })).resolves.toBe(false);
  await expect(canViewAuction({}, { state: 'active' })).resolves.toBe(true);
});
