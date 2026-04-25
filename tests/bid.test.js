'use strict';

/**
 * Bid engine tests — unified proxy-based bidding.
 *
 * All DB calls are mocked. The mock client dispatches responses by matching
 * SQL keywords so tests remain readable even if minor query wording changes.
 *
 * Functions under test (from bidService.js):
 *   resolveBidIncrement  — exported, tested directly
 *   createBid            — exported, tested via mocked db.connect()
 */

jest.mock('../src/db/index', () => ({
  connect: jest.fn(),
  query:   jest.fn(),
}));

const db                                  = require('../src/db/index');
const { createBid, resolveBidIncrement }  = require('../src/services/bidService');

// ── Factories ─────────────────────────────────────────────────────────────────

function makeLot(overrides = {}) {
  return {
    id:                      'lot-aaa',
    auction_id:              'auction-aaa',
    status:                  'active',
    current_bid_cents:       0,
    starting_bid_cents:      100,
    current_price:           0,
    bid_increment_cents:     null,   // null → walk hierarchy
    closes_at:               null,
    current_winner_user_id:  null,
    ...overrides,
  };
}

function makeBidRow(overrides = {}) {
  return {
    id:         'bid-1',
    lot_id:     'lot-aaa',
    user_id:    'user-1',
    amount:     1.00,
    is_proxy:   true,
    created_at: new Date(),
    ...overrides,
  };
}

function makeProxyRow(userId, maxCents, createdAt = new Date()) {
  return { bidder_user_id: userId, max_amount_cents: maxCents, created_at: createdAt };
}

/**
 * Build a mock pg client whose .query() dispatches by SQL keyword.
 *
 * `overrides` is a map from a lowercase keyword/phrase → response value:
 *   { rows, rowCount } or a plain array (treated as rows).
 * Keys are matched against the lowercased SQL string (first match wins).
 * Anything not matched returns { rows: [], rowCount: 0 }.
 */
function makeClient(overrides = {}) {
  const client = {
    query:   jest.fn(),
    release: jest.fn(),
  };

  client.query.mockImplementation(async (sql = '') => {
    const s = sql.toLowerCase();

    for (const [keyword, value] of Object.entries(overrides)) {
      if (s.includes(keyword.toLowerCase())) {
        if (value instanceof Error) throw value;
        if (Array.isArray(value))   return { rows: value, rowCount: value.length };
        return value;
      }
    }
    return { rows: [], rowCount: 0 };
  });

  return client;
}

// ── resolveBidIncrement — unit tests (no createBid involved) ──────────────────

describe('resolveBidIncrement', () => {
  let client;
  beforeEach(() => {
    client = makeClient({
      'from auctions':     { rows: [{ bid_increment_cents: null, auction_house_id: 'house-1' }] },
      'from auction_houses': { rows: [{ default_bid_increment_cents: 750 }] },
    });
  });

  test('G — lot-level override is returned immediately, no DB query fired', async () => {
    const lot = makeLot({ bid_increment_cents: 250 });
    const result = await resolveBidIncrement(client, lot);
    expect(result).toBe(250);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('H — auction-level override is returned when lot has none', async () => {
    client = makeClient({
      'from auctions': { rows: [{ bid_increment_cents: 1000, auction_house_id: null }] },
    });
    const lot = makeLot({ bid_increment_cents: null });
    const result = await resolveBidIncrement(client, lot);
    expect(result).toBe(1000);
  });

  test('I — auction-house default used when lot and auction have none', async () => {
    const lot = makeLot({ bid_increment_cents: null });
    const result = await resolveBidIncrement(client, lot);
    expect(result).toBe(750);
  });

  test('fallback 500 when no lot, no auction, no house', async () => {
    client = makeClient({
      'from auctions':       { rows: [{ bid_increment_cents: null, auction_house_id: 'house-1' }] },
      'from auction_houses': { rows: [] },   // house not found
    });
    const lot = makeLot({ bid_increment_cents: null });
    const result = await resolveBidIncrement(client, lot);
    expect(result).toBe(500);
  });

  test('fallback 500 when lot has no auction_id', async () => {
    const lot = makeLot({ bid_increment_cents: null, auction_id: null });
    const result = await resolveBidIncrement(client, lot);
    expect(result).toBe(500);
    expect(client.query).not.toHaveBeenCalled();
  });
});

// ── createBid — integrated tests (mocked client) ─────────────────────────────

/**
 * Wire db.connect() to return `client`, then call createBid with args.
 */
async function bid(client, lotId, userId, args) {
  db.connect.mockResolvedValueOnce(client);
  return createBid(lotId, userId, args);
}

// Shared lot that has a lot-level increment so auction queries are skipped.
const BASE_LOT = makeLot({ bid_increment_cents: 500 });

describe('createBid — proxy resolution', () => {

  // ── A ──────────────────────────────────────────────────────────────────────
  test('A — first bidder: visible price stays at starting bid', async () => {
    const proxies = [makeProxyRow('user-1', 5000)];
    const client  = makeClient({
      'for update':          { rows: [BASE_LOT] },
      'lot_proxy_bids\n     where lot_id': [makeProxyRow('user-1', 5000)],
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow({ user_id: 'user-1', amount: 1.00 })] },
    });

    const result = await bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 5000 });

    expect(result.visible_cents).toBe(100);   // starting_bid_cents = 100
    expect(result.winner_user_id).toBe('user-1');
    expect(result.is_proxy).toBe(true);
  });

  // ── B ──────────────────────────────────────────────────────────────────────
  test('B — second bidder with lower max: original winner stays, price advances', async () => {
    // Lot: user-1 already holds visible at 100 cents (starting bid), increment=500.
    // user-2 submits max=1500 — clears minAllowed(=600) but loses to user-1's 5000.
    const lot     = makeLot({ bid_increment_cents: 500, current_bid_cents: 100 });
    const proxies = [
      makeProxyRow('user-1', 5000, new Date('2025-01-01T10:00:00Z')),
      makeProxyRow('user-2', 1500, new Date('2025-01-01T10:01:00Z')),
    ];
    const client  = makeClient({
      'for update':          { rows: [lot] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow({ user_id: 'user-1', amount: 20.00 })] },
    });

    const result = await bid(client, 'lot-aaa', 'user-2', { max_bid_cents: 1500 });

    // visible = min(1500 + 500, 5000) = 2000
    expect(result.visible_cents).toBe(2000);
    expect(result.winner_user_id).toBe('user-1');
  });

  // ── C ──────────────────────────────────────────────────────────────────────
  test('C — second bidder with higher max: becomes winner, price = prior max + increment', async () => {
    const lot     = makeLot({ bid_increment_cents: 500, current_bid_cents: 100 });
    const proxies = [
      makeProxyRow('user-2', 2000, new Date('2025-01-01T10:01:00Z')),
      makeProxyRow('user-1',  500, new Date('2025-01-01T10:00:00Z')),
    ];
    const client  = makeClient({
      'for update':          { rows: [lot] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow({ user_id: 'user-2', amount: 10.00 })] },
    });

    const result = await bid(client, 'lot-aaa', 'user-2', { max_bid_cents: 2000 });

    // visible = min(500 + 500, 2000) = 1000
    expect(result.visible_cents).toBe(1000);
    expect(result.winner_user_id).toBe('user-2');
  });

  // ── D ──────────────────────────────────────────────────────────────────────
  test('D — equal max bids: earliest created_at wins, visible capped at winner max', async () => {
    const lot     = makeLot({ bid_increment_cents: 500 });
    const earlier = new Date('2025-01-01T09:00:00Z');
    const later   = new Date('2025-01-01T09:01:00Z');
    // DB returns them sorted: same max, earlier first.
    const proxies = [
      makeProxyRow('user-1', 5000, earlier),
      makeProxyRow('user-2', 5000, later),
    ];
    const client  = makeClient({
      'for update':          { rows: [lot] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow({ user_id: 'user-1', amount: 50.00 })] },
    });

    const result = await bid(client, 'lot-aaa', 'user-2', { max_bid_cents: 5000 });

    // visible = min(5000 + 500, 5000) = 5000 (capped at winner max)
    expect(result.visible_cents).toBe(5000);
    expect(result.winner_user_id).toBe('user-1');
  });

  // ── E ──────────────────────────────────────────────────────────────────────
  test('E — manual amount bid is treated identically to max_bid_cents of same value', async () => {
    const proxies = [makeProxyRow('user-1', 1000)];
    const clientA = makeClient({
      'for update':          { rows: [BASE_LOT] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow({ user_id: 'user-1' })] },
    });
    const clientB = makeClient({
      'for update':          { rows: [BASE_LOT] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow({ user_id: 'user-1' })] },
    });

    db.connect
      .mockResolvedValueOnce(clientA)
      .mockResolvedValueOnce(clientB);

    const [resultA, resultB] = await Promise.all([
      createBid('lot-aaa', 'user-1', { amount: 10.00 }),
      createBid('lot-aaa', 'user-1', { max_bid_cents: 1000 }),
    ]);

    // Both paths must produce identical visible_cents and winner.
    expect(resultA.visible_cents).toBe(resultB.visible_cents);
    expect(resultA.winner_user_id).toBe(resultB.winner_user_id);

    // Verify normalization: INSERT into lot_proxy_bids was called with 1000 in both cases.
    const insertCallA = clientA.query.mock.calls.find(
      ([sql]) => sql && sql.toLowerCase().includes('insert into lot_proxy_bids')
    );
    const insertCallB = clientB.query.mock.calls.find(
      ([sql]) => sql && sql.toLowerCase().includes('insert into lot_proxy_bids')
    );
    expect(insertCallA[1][2]).toBe(1000);   // params[2] = max_amount_cents
    expect(insertCallB[1][2]).toBe(1000);
  });

  // ── F ──────────────────────────────────────────────────────────────────────
  test('F — bid below minimum increment is rejected before any DB write', async () => {
    // current_bid_cents=1000, increment=500 → minAllowed=1500
    const lot    = makeLot({ bid_increment_cents: 500, current_bid_cents: 1000 });
    const client = makeClient({ 'for update': { rows: [lot] } });

    await expect(
      bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 1200 })
    ).rejects.toThrow('Bid must be at least $15.00');

    // No proxy upsert should have been attempted.
    const proxyCalls = client.query.mock.calls.filter(
      ([sql]) => sql && sql.toLowerCase().includes('lot_proxy_bids')
    );
    expect(proxyCalls).toHaveLength(0);
  });

  test('F — missing amount AND max_bid_cents rejected before DB connect', async () => {
    // normalization happens before db.connect, so db.connect should not be called
    db.connect.mockClear();
    await expect(
      createBid('lot-aaa', 'user-1', {})
    ).rejects.toThrow('Enter a bid amount or max bid');
    expect(db.connect).not.toHaveBeenCalled();
  });
});

// ── Anti-snipe ────────────────────────────────────────────────────────────────

describe('createBid — anti-snipe (J)', () => {

  test('J — bid within final 60 s triggers closes_at extension', async () => {
    const closesSoon   = new Date(Date.now() + 30_000).toISOString();   // 30 s from now
    const extendedTime = new Date(Date.now() + 90_000);
    const lot          = makeLot({ bid_increment_cents: 500, closes_at: closesSoon });
    const proxies      = [makeProxyRow('user-1', 1000)];

    const client = makeClient({
      'for update':          { rows: [lot] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow()] },
      // Anti-snipe UPDATE returns the new closes_at
      'closes_at = closes_at': { rows: [{ closes_at: extendedTime }], rowCount: 1 },
    });

    const result = await bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 1000 });

    expect(result.closes_at).toEqual(extendedTime);

    // Confirm the extension UPDATE was issued.
    const snipeCalls = client.query.mock.calls.filter(
      ([sql]) => sql && sql.toLowerCase().includes('closes_at = closes_at')
    );
    expect(snipeCalls.length).toBeGreaterThan(0);
  });

  test('J — bid with plenty of time remaining does NOT extend closes_at', async () => {
    const closesLater = new Date(Date.now() + 300_000).toISOString();  // 5 min from now
    const lot         = makeLot({ bid_increment_cents: 500, closes_at: closesLater });
    const proxies     = [makeProxyRow('user-1', 1000)];

    const client = makeClient({
      'for update':          { rows: [lot] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow()] },
    });

    const result = await bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 1000 });

    // closes_at should equal the original (no extension).
    expect(new Date(result.closes_at).getTime()).toBe(new Date(closesLater).getTime());

    const snipeCalls = client.query.mock.calls.filter(
      ([sql]) => sql && sql.toLowerCase().includes('closes_at = closes_at')
    );
    expect(snipeCalls).toHaveLength(0);
  });
});

// ── Increment hierarchy (via createBid) ───────────────────────────────────────

describe('createBid — increment hierarchy', () => {

  function clientWithIncrement(lotIncrement, auctionIncrement, houseIncrement, proxies) {
    const lot = makeLot({
      bid_increment_cents: lotIncrement,
      // null lot increment → walks to auction
    });
    return {
      lot,
      client: makeClient({
        'for update':          { rows: [lot] },
        'from auctions':       { rows: [{ bid_increment_cents: auctionIncrement, auction_house_id: houseIncrement != null ? 'house-1' : null }] },
        'from auction_houses': { rows: houseIncrement != null ? [{ default_bid_increment_cents: houseIncrement }] : [] },
        'from lot_proxy_bids': { rows: proxies },
        'insert into bids':    { rows: [makeBidRow()] },
      }),
    };
  }

  test('G — lot-level increment applied in validation (bid just below rejected)', async () => {
    // lot increment = 250 cents; current = 0; starting = 100
    // minAllowed = max(100, 0+250) = 250 → bid of 200 must be rejected
    const lot    = makeLot({ bid_increment_cents: 250, current_bid_cents: 0 });
    const client = makeClient({ 'for update': { rows: [lot] } });

    await expect(
      bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 200 })
    ).rejects.toThrow('Bid must be at least $2.50');
  });

  test('G — lot-level increment used in proxy visible price', async () => {
    const lot     = makeLot({ bid_increment_cents: 250 });
    const proxies = [
      makeProxyRow('user-1', 2000, new Date('2025-01-01T10:00:00Z')),
      makeProxyRow('user-2', 1000, new Date('2025-01-01T10:01:00Z')),
    ];
    const client  = makeClient({
      'for update':          { rows: [lot] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow()] },
    });

    const result = await bid(client, 'lot-aaa', 'user-2', { max_bid_cents: 1000 });

    // visible = min(1000 + 250, 2000) = 1250
    expect(result.visible_cents).toBe(1250);
  });

  test('H — auction-level increment used when lot has none', async () => {
    // lot: no increment. auction: 1000. minAllowed = max(100, 0+1000) = 1000
    const { client } = clientWithIncrement(null, 1000, null, [makeProxyRow('user-1', 1500)]);

    const resultOk = await bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 1500 });
    expect(resultOk.visible_cents).toBe(100);  // only bidder → starting bid

    // Now test rejection: a fresh client for the failing bid
    const { client: client2 } = clientWithIncrement(null, 1000, null, []);
    await expect(
      bid(client2, 'lot-aaa', 'user-1', { max_bid_cents: 500 })
    ).rejects.toThrow('Bid must be at least $10.00');
  });

  test('I — auction-house default increment used when lot and auction have none', async () => {
    // house default = 750; minAllowed = max(100, 0+750) = 750
    const { client } = clientWithIncrement(null, null, 750, [makeProxyRow('user-1', 1000)]);

    const result = await bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 1000 });
    expect(result.visible_cents).toBe(100);  // only bidder → starting bid

    const { client: client2 } = clientWithIncrement(null, null, 750, []);
    await expect(
      bid(client2, 'lot-aaa', 'user-1', { max_bid_cents: 400 })
    ).rejects.toThrow('Bid must be at least $7.50');
  });
});

// ── Concurrency and isolation ─────────────────────────────────────────────────

describe('createBid — concurrency and lot isolation', () => {

  test('K — FOR UPDATE lock query is issued, ensuring serialization', async () => {
    const proxies = [makeProxyRow('user-1', 1000)];
    const client  = makeClient({
      'for update':          { rows: [BASE_LOT] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow()] },
    });

    await bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 1000 });

    const lockCall = client.query.mock.calls.find(
      ([sql]) => sql && sql.toLowerCase().includes('for update')
    );
    expect(lockCall).toBeDefined();
    // Confirm the locked lot ID matches what was requested.
    expect(lockCall[1]).toEqual(['lot-aaa']);
  });

  test('K — second sequential bid sees updated current_bid_cents', async () => {
    // Simulate: first bid sets visible price to 100 (starting bid).
    // Second bid arrives with current_bid_cents already at 100.
    const lot1    = makeLot({ bid_increment_cents: 500, current_bid_cents: 0 });
    const lot2    = makeLot({ bid_increment_cents: 500, current_bid_cents: 100 });

    const client1 = makeClient({
      'for update':          { rows: [lot1] },
      'from lot_proxy_bids': { rows: [makeProxyRow('user-1', 5000)] },
      'insert into bids':    { rows: [makeBidRow({ user_id: 'user-1', amount: 1.00 })] },
    });
    const client2 = makeClient({
      'for update':          { rows: [lot2] },
      'from lot_proxy_bids': { rows: [
        makeProxyRow('user-1', 5000, new Date('2025-01-01T10:00:00Z')),
        makeProxyRow('user-2', 2000, new Date('2025-01-01T10:01:00Z')),
      ]},
      'insert into bids':    { rows: [makeBidRow({ user_id: 'user-1', amount: 25.00 })] },
    });

    db.connect
      .mockResolvedValueOnce(client1)
      .mockResolvedValueOnce(client2);

    const r1 = await createBid('lot-aaa', 'user-1', { max_bid_cents: 5000 });
    const r2 = await createBid('lot-aaa', 'user-2', { max_bid_cents: 2000 });

    expect(r1.visible_cents).toBe(100);   // first bidder: starting bid
    expect(r2.visible_cents).toBe(2500);  // min(2000+500, 5000) = 2500
    expect(r2.winner_user_id).toBe('user-1');
  });

  test('L — bids on different lots do not interfere', async () => {
    const lotA = makeLot({ id: 'lot-aaa', bid_increment_cents: 500 });
    const lotB = makeLot({ id: 'lot-bbb', bid_increment_cents: 1000 });

    const clientA = makeClient({
      'for update':          { rows: [lotA] },
      'from lot_proxy_bids': { rows: [makeProxyRow('user-1', 5000)] },
      'insert into bids':    { rows: [makeBidRow({ lot_id: 'lot-aaa' })] },
    });
    const clientB = makeClient({
      'for update':          { rows: [lotB] },
      'from lot_proxy_bids': { rows: [makeProxyRow('user-2', 3000)] },
      'insert into bids':    { rows: [makeBidRow({ lot_id: 'lot-bbb', user_id: 'user-2' })] },
    });

    db.connect
      .mockResolvedValueOnce(clientA)
      .mockResolvedValueOnce(clientB);

    const [rA, rB] = await Promise.all([
      createBid('lot-aaa', 'user-1', { max_bid_cents: 5000 }),
      createBid('lot-bbb', 'user-2', { max_bid_cents: 3000 }),
    ]);

    expect(rA.winner_user_id).toBe('user-1');
    expect(rB.winner_user_id).toBe('user-2');

    // Lot A proxy INSERT used lot-aaa; lot B used lot-bbb.
    const proxyInsertA = clientA.query.mock.calls.find(
      ([sql]) => sql && sql.toLowerCase().includes('insert into lot_proxy_bids')
    );
    const proxyInsertB = clientB.query.mock.calls.find(
      ([sql]) => sql && sql.toLowerCase().includes('insert into lot_proxy_bids')
    );
    expect(proxyInsertA[1][0]).toBe('lot-aaa');
    expect(proxyInsertB[1][0]).toBe('lot-bbb');
  });
});

// ── Transaction safety ────────────────────────────────────────────────────────

describe('createBid — transaction safety', () => {

  test('ROLLBACK is called when resolveProxyBid throws', async () => {
    const lot    = makeLot({ bid_increment_cents: 500 });
    const client = makeClient({
      'for update':          { rows: [lot] },
      // Force proxy upsert to throw
      'insert into lot_proxy_bids': new Error('DB constraint violation'),
    });

    await expect(
      bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 1000 })
    ).rejects.toThrow('DB constraint violation');

    const rollbackCall = client.query.mock.calls.find(
      ([sql]) => sql && sql.toLowerCase().includes('rollback')
    );
    expect(rollbackCall).toBeDefined();
    expect(client.release).toHaveBeenCalled();
  });

  test('client.release() is always called, even on success', async () => {
    const proxies = [makeProxyRow('user-1', 1000)];
    const client  = makeClient({
      'for update':          { rows: [BASE_LOT] },
      'from lot_proxy_bids': { rows: proxies },
      'insert into bids':    { rows: [makeBidRow()] },
    });

    await bid(client, 'lot-aaa', 'user-1', { max_bid_cents: 1000 });
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
