'use strict';

/**
 * Cross-seller lot authorization (security fix 2026-10-12).
 *
 * Before the fix:
 *   - POST /api/lots used canMutateAuction, which never checked ownership and read the CALLER's seller type:
 *     any signed-in user could create a lot in another seller's DRAFT auction, and a Professional Seller could
 *     create one in another seller's auction in ANY state (including a live, published auction).
 *   - POST /api/lots/:lotId/images had no ownership or edit-lock check: any signed-in user could attach images
 *     to any lot.
 * Now both require that the caller owns the auction (admins excepted), and the edit-lock follows the OWNER.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/services/imageProcessingService', () => ({ createProcessingJob: jest.fn(async () => ({})) }), { virtual: false });

const db = require('../src/db');
const lotsRouter = require('../src/routes/lots');
const { canMutateAuction } = require('../src/routes/lots');

const AID = '11111111-1111-4111-8111-111111111111';
const LID = '22222222-2222-4222-8222-222222222222';
const OWNER = { id: 'owner-1', role: 'seller' };
const OTHER_SELLER = { id: 'other-1', role: 'seller' };
const BUYER = { id: 'buyer-1', role: 'buyer' };
const ADMIN = { id: 'admin-1', role: 'admin' };

function handlerFor(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  const st = layer.route.stack; return st[st.length - 1].handle;
}
async function call(method, routePath, { params = {}, body = {}, user }) {
  let status = 200, out = null;
  const res = { set() { return res; }, status(c) { status = c; return res; }, json(b) { out = b; return res; } };
  await handlerFor(lotsRouter, method, routePath)({ params, body, query: {}, headers: {}, user }, res, (e) => { if (e) throw e; });
  return { status, body: out };
}

// World: one auction owned by OWNER. Its state and the owner's seller type vary per test; the caller's own
// seller profile is deliberately PROFESSIONAL so the old caller-type bug would have let them through.
let auction;
const inserts = [];
beforeEach(() => {
  auction = { state: 'draft', owner_seller_type: 'private' };
  inserts.length = 0;
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    if (/SELECT a\.state, sp\.seller_type, sp\.user_id AS owner_user_id\s+FROM auctions a/.test(sql)) {
      return { rows: [{ state: auction.state, seller_type: auction.owner_seller_type, owner_user_id: OWNER.id }] };
    }
    // Pre-fix query shape (caller's own profile): answer as a Professional caller, to prove it is no longer used.
    if (/LEFT JOIN seller_profiles sp ON sp\.user_id = \$2/.test(sql)) return { rows: [{ state: auction.state, seller_type: 'auction_house' }] };
    if (/SELECT 1 FROM lots l/.test(sql)) return { rows: params[1] === OWNER.id ? [{ '?column?': 1 }] : [] };   // userOwnsLot
    if (/SELECT auction_id FROM lots WHERE id/.test(sql)) return { rows: [{ auction_id: AID }] };
    if (/SELECT sp\.seller_type FROM auctions a|SELECT sp\.seller_type, sp\.capabilities FROM/.test(sql)) return { rows: [{ seller_type: auction.owner_seller_type, capabilities: {} }] };
    if (/INSERT INTO lots/.test(sql)) { inserts.push('lot'); return { rows: [{ id: LID }] }; }
    if (/INSERT INTO lot_images/.test(sql)) { inserts.push('image'); return { rows: [] }; }
    return { rows: [] };
  });
});

const lotBody = { auctionId: AID, title: 'Injected lot', size_category: 'A' };

describe('canMutateAuction: ownership first, edit-lock follows the owner', () => {
  test('a non-owner is refused in every auction state, even as a Professional Seller', async () => {
    for (const state of ['draft', 'submitted', 'published', 'active']) {
      auction.state = state;
      expect(await canMutateAuction(OTHER_SELLER.id, 'seller', AID)).toEqual({ allowed: false, reason: 'not_owner' });
      expect(await canMutateAuction(BUYER.id, 'buyer', AID)).toEqual({ allowed: false, reason: 'not_owner' });
    }
  });
  test('the owner keeps the existing rules: draft editable; Individual locked after submission; Professional may edit', async () => {
    auction.state = 'draft';
    expect(await canMutateAuction(OWNER.id, 'seller', AID)).toEqual({ allowed: true, reason: 'draft' });
    auction.state = 'published';
    expect((await canMutateAuction(OWNER.id, 'seller', AID)).reason).toBe('auction_locked_after_submission');
    auction.owner_seller_type = 'auction_house';
    expect((await canMutateAuction(OWNER.id, 'seller', AID)).allowed).toBe(true);
  });
  test('admins keep full control', async () => {
    auction.state = 'active';
    expect(await canMutateAuction(ADMIN.id, 'admin', AID)).toEqual({ allowed: true, reason: 'admin' });
  });
});

describe('POST /api/lots: no lot can be created in another seller\'s auction', () => {
  test.each([['draft'], ['published'], ['active']])('auction %s: another seller and a buyer get 403 and nothing is inserted', async (state) => {
    auction.state = state;
    for (const user of [OTHER_SELLER, BUYER]) {
      const r = await call('post', '/', { body: lotBody, user });
      expect(r.status).toBe(403);
    }
    expect(inserts).toEqual([]);
  });
  test('the owner can still create a lot in their own draft auction; an admin can too', async () => {
    expect((await call('post', '/', { body: lotBody, user: OWNER })).status).toBe(201);
    expect((await call('post', '/', { body: lotBody, user: ADMIN })).status).toBe(201);
    expect(inserts.filter((x) => x === 'lot').length).toBe(2);
  });
});

describe('POST /api/lots/:lotId/images: only the lot owner (or an admin) can attach images', () => {
  const imgs = { images: ['https://example.org/a.jpg'] };
  test('another seller and a buyer get 403 and no image row is written', async () => {
    for (const user of [OTHER_SELLER, BUYER]) {
      const r = await call('post', '/:lotId/images', { params: { lotId: LID }, body: imgs, user });
      expect(r.status).toBe(403);
    }
    expect(inserts).toEqual([]);
  });
  test('the owner of a locked (submitted) Individual auction is refused by the edit-lock', async () => {
    auction.state = 'submitted';
    expect((await call('post', '/:lotId/images', { params: { lotId: LID }, body: imgs, user: OWNER })).status).toBe(403);
    expect(inserts).toEqual([]);
  });
  test('the owner of a draft auction and an admin can attach images', async () => {
    expect((await call('post', '/:lotId/images', { params: { lotId: LID }, body: imgs, user: OWNER })).body).toMatchObject({ success: true });
    expect((await call('post', '/:lotId/images', { params: { lotId: LID }, body: imgs, user: ADMIN })).body).toMatchObject({ success: true });
    expect(inserts).toEqual(['image', 'image']);
  });
});
