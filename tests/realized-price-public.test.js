'use strict';

/**
 * Realized prices of CLOSED lots are for signed-in members only (#20.1, owner reconfirmed 2026-10-15): every public,
 * signed-out surface hides them, while open lots keep their live price and listings stay visible.
 */
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');
const rawQuery = db.query; // Sasha's tool guard wraps db.query once tools.js loads; the mock underneath stays this one
const { redactRealizedPrice } = require('../src/lib/realizedPrice');

function handlerFor(router, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.get);
  const st = layer.route.stack; return st[st.length - 1].handle;
}
async function get(router, routePath, { params = {}, query = {} } = {}) {
  let out = null, status = 200;
  const res = { set() { return res; }, status(c) { status = c; return res; }, json(b) { out = b; return res; } };
  await handlerFor(router, routePath)({ params, query, headers: {} }, res, (e) => { if (e) throw e; });
  return { status, body: out };
}
const closed = { id: 'l1', state: 'closed', current_bid_cents: 12300, starting_bid_cents: 100, bid_count: 7 };
const open = { id: 'l2', state: 'open', current_bid_cents: 4500, starting_bid_cents: 100, bid_count: 3 };
beforeEach(() => jest.clearAllMocks());

test('the helper recognises the lot_state alias used by cross-auction feeds', () => {
  expect(redactRealizedPrice({ lot_state: 'closed', current_bid_cents: 5 }, false)).toMatchObject({ current_bid_cents: null, realized_price_hidden: true });
  expect(redactRealizedPrice({ lot_state: 'open', current_bid_cents: 5 }, false).current_bid_cents).toBe(5);
  expect(redactRealizedPrice({ state: 'closed', current_bid_cents: 5 }, true).current_bid_cents).toBe(5);
});

describe('public lot feeds (publicly cached, always signed-out)', () => {
  const router = require('../src/routes/public');
  test('/auctions/:id/lots: closed lot price hidden, open lot price kept, listing still returned', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'a1' }] })
      .mockResolvedValueOnce({ rows: [{ ...closed, total_count: 2 }, { ...open, total_count: 2 }] });
    const r = await get(router, '/auctions/:id/lots', { params: { id: '11111111-1111-4111-8111-111111111111' } });
    expect(r.body.data).toHaveLength(2);
    expect(r.body.data[0]).toMatchObject({ id: 'l1', current_bid_cents: null, realized_price_hidden: true, bid_count: 7 });
    expect(r.body.data[1]).toMatchObject({ id: 'l2', current_bid_cents: 4500 });
  });
  test('/featured-lots and /lots/recently-added hide closed lot prices', async () => {
    for (const p of ['/featured-lots', '/lots/recently-added']) {
      db.query.mockResolvedValueOnce({ rows: [{ id: 'l1', lot_state: 'closed', current_bid_cents: 9900 }, { id: 'l2', lot_state: 'open', current_bid_cents: 800 }] });
      const r = await get(router, p);
      expect(r.body.data[0]).toMatchObject({ current_bid_cents: null, realized_price_hidden: true });
      expect(r.body.data[1].current_bid_cents).toBe(800);
    }
  });
});

test('shared-link metadata (JSON-LD offers) omits the price of a closed lot', async () => {
  const svc = require('../src/services/shareMetaService');
  db.query.mockResolvedValueOnce({ rows: [{ title: 'Lamp', lot_number: 4, auction_id: 'a1', lot_state: 'closed', current_bid_cents: 12300, starting_bid_cents: 100, auction_title: 'Estate' }] });
  const m = await svc.getLotMeta('11111111-1111-4111-8111-111111111111');
  expect(JSON.stringify(m)).not.toMatch(/123(\.00)?|12300/);
  expect(m.priceCents == null).toBe(true);
  expect(db.query.mock.calls[0][0]).toMatch(/l\.state AS lot_state/);
});

test('Sasha does not read a closed lot\'s final price to a signed-out visitor (but does to a signed-in one)', async () => {
  const tools = require('../src/services/sasha/tools')._internal;
  const auction = { id: 'a1', title: 'Estate', state: 'closed', city: 'Houston', address_state: 'TX' };
  const lot = { id: '22222222-2222-4222-8222-222222222222', auction_id: 'a1', lot_number: 4, title: 'Lamp', state: 'closed', current_bid_cents: 12300, starting_bid_cents: 100, bid_count: 7 };
  const run = async (userId) => {
    rawQuery.mockReset();
    rawQuery.mockImplementation(async (sql) => {
      if (/FROM lots WHERE id = \$1/.test(sql)) return { rows: [lot] };
      if (/FROM auctions a LEFT JOIN seller_profiles/.test(sql)) return { rows: [auction] };
      return { rows: [] };
    });
    return tools.getAuctionOrLot({ lot_id: lot.id }, { userId });
  };
  const anon = await run(null);
  expect(anon.lot.current_bid).toBeNull(); expect(anon.lot.next_minimum_bid).toBeNull(); expect(anon.lot.price_note).toMatch(/signed-in members/);
  const member = await run('u-1');
  expect(member.lot.current_bid).toBe('$123.00'); expect(member.lot.price_note).toBeUndefined();
});
