'use strict';

/**
 * Launch Sprint 1 — Tier-1 integration tests.
 * LR-P0-1: publishAuction guards (start_time + >=1 lot).
 * LR-P1-1: winner WINNING notification enqueue + no double-enqueue across the two close paths.
 * Scratch-only (isolated Neon branch). Skips unless LAUNCH_SCRATCH=1 + non-prod DATABASE_URL.
 */

const SCRATCH_OK = !!process.env.LAUNCH_SCRATCH && !/ep-proud-leaf/.test(process.env.DATABASE_URL || '');
if (!SCRATCH_OK) console.warn('[launch-lifecycle] SKIPPED — LAUNCH_SCRATCH=1 + non-prod DATABASE_URL required.');
const suite = SCRATCH_OK ? describe : describe.skip;

const db = require('../../src/db');
const auctionService = require('../../src/services/auctionService');

let SELLER_PROFILE, BUYER, stamp;
const mkAuction = async (withStart) => {
  const a = await auctionService.createAuction({ sellerId: SELLER_PROFILE, title: 'LR Test ' + (stamp++), state: 'draft', startTime: withStart || null });
  return a.id;
};
const addLot = async (auctionId, n) => (await db.query(
  "INSERT INTO lots (auction_id, lot_number, title, size_category, starting_bid_cents, state) VALUES ($1,$2,$3,'A',100,'open') RETURNING id",
  [auctionId, n || 1, 'Lot ' + (n || 1)])).rows[0].id;
// A lot carrying a seller reserve (professional feature). starting_bid stays $1; reserve is the sell floor.
const addLotWithReserve = async (auctionId, n, reserveCents) => (await db.query(
  "INSERT INTO lots (auction_id, lot_number, title, size_category, starting_bid_cents, state, reserve_cents) VALUES ($1,$2,$3,'A',100,'open',$4) RETURNING id",
  [auctionId, n || 1, 'Reserve Lot ' + (n || 1), reserveCents])).rows[0].id;
const lotOutcome = async (id) => (await db.query('SELECT state, winning_buyer_user_id, winning_amount_cents, reserve_not_met FROM lots WHERE id=$1', [id])).rows[0];
// A lot the seller explicitly withdrew while the auction was still a Draft (state + flag, as prod does).
const addWithdrawnLot = async (auctionId, n) => (await db.query(
  "INSERT INTO lots (auction_id, lot_number, title, size_category, starting_bid_cents, state, is_withdrawn) VALUES ($1,$2,$3,'A',100,'withdrawn',true) RETURNING id",
  [auctionId, n, 'Withdrawn Lot ' + n])).rows[0].id;
const lotRow = async (id) => (await db.query('SELECT state, is_withdrawn, closes_at FROM lots WHERE id=$1', [id])).rows[0];
const addBid = async (auctionId, lotId, cents) => db.query(
  'INSERT INTO bids (lot_id, auction_id, bidder_user_id, amount_cents) VALUES ($1,$2,$3,$4)', [lotId, auctionId, BUYER, cents]);
const winningCount = async (userId) => (await db.query("SELECT count(*)::int c FROM notifications_queue WHERE user_id=$1 AND type='WINNING'", [userId])).rows[0].c;

beforeAll(async () => {
  if (!SCRATCH_OK) return;
  stamp = Date.now();
  const su = (await db.query("INSERT INTO users (email, role, password_hash) VALUES ($1,'seller','x') RETURNING id", ['lr-seller-' + stamp + '@t.test'])).rows[0].id;
  SELLER_PROFILE = (await db.query("INSERT INTO seller_profiles (user_id, seller_type) VALUES ($1,'private') RETURNING id", [su])).rows[0].id;
  BUYER = (await db.query("INSERT INTO users (email, role, password_hash) VALUES ($1,'buyer','x') RETURNING id", ['lr-buyer-' + stamp + '@t.test'])).rows[0].id;
});
afterAll(async () => { if (!SCRATCH_OK) return; await db.pool.end(); });

suite('LR-P0-1 publish guard', () => {
  test('rejects publish without start_time', async () => {
    const id = await mkAuction(null);
    await addLot(id, 1);
    await expect(auctionService.publishAuction(id)).rejects.toMatchObject({ code: 'START_TIME_REQUIRED' });
  });
  test('rejects publish with no lots', async () => {
    const id = await mkAuction(new Date(Date.now() + 3600e3).toISOString());
    await expect(auctionService.publishAuction(id)).rejects.toMatchObject({ code: 'AUCTION_HAS_NO_LOTS' });
  });
  test('publishes with start_time + lot; schedules closes_at + end_time', async () => {
    const id = await mkAuction(new Date(Date.now() + 3600e3).toISOString());
    await addLot(id, 1);
    const pub = await auctionService.publishAuction(id);
    expect(pub.state).toBe('published');
    const lot = (await db.query('SELECT closes_at FROM lots WHERE auction_id=$1', [id])).rows[0];
    expect(lot.closes_at).toBeTruthy();
    expect((await db.query('SELECT end_time FROM auctions WHERE id=$1', [id])).rows[0].end_time).toBeTruthy();
  });
});

suite('H-2 publish never resurrects withdrawn lots (seller intent authoritative)', () => {
  const future = () => new Date(Date.now() + 3600e3).toISOString();

  test('1. a withdrawn lot stays withdrawn after publish (no closes_at, not reopened)', async () => {
    const id = await mkAuction(future());
    await addLot(id, 1);                                  // an open lot so the publish guard passes
    const w = await addWithdrawnLot(id, 2);
    const pub = await auctionService.publishAuction(id);
    expect(pub.state).toBe('published');
    const wl = await lotRow(w);
    expect(wl.state).toBe('withdrawn');                   // still withdrawn
    expect(wl.is_withdrawn).toBe(true);                   // flag preserved (no inconsistent row)
    expect(wl.closes_at).toBeNull();                      // never scheduled → not biddable
  });

  test('2. an open lot publishes normally (scheduled with closes_at)', async () => {
    const id = await mkAuction(future());
    const o = await addLot(id, 1);
    await auctionService.publishAuction(id);
    const ol = await lotRow(o);
    expect(ol.state).toBe('open');
    expect(ol.closes_at).toBeTruthy();
  });

  test('3. a mixed auction publishes correctly (open scheduled, withdrawn untouched)', async () => {
    const id = await mkAuction(future());
    const o = await addLot(id, 1);
    const w = await addWithdrawnLot(id, 2);
    const pub = await auctionService.publishAuction(id);
    expect(pub.state).toBe('published');
    const ol = await lotRow(o), wl = await lotRow(w);
    expect(ol).toMatchObject({ state: 'open' });
    expect(ol.closes_at).toBeTruthy();
    expect(wl).toMatchObject({ state: 'withdrawn', is_withdrawn: true });
    expect(wl.closes_at).toBeNull();
  });

  test('4. a seller cannot accidentally relist a withdrawn lot via publish', async () => {
    const id = await mkAuction(future());
    await addLot(id, 1);
    const w = await addWithdrawnLot(id, 2);
    await auctionService.publishAuction(id);
    // The withdrawn lot is absent from the biddable/catalog set (state='open' with a close time).
    const biddable = (await db.query(
      "SELECT id FROM lots WHERE auction_id=$1 AND state='open' AND closes_at IS NOT NULL", [id])).rows.map((r) => r.id);
    expect(biddable).not.toContain(w);
    expect((await lotRow(w)).state).toBe('withdrawn');
  });
});

suite('LR-P1-1 winner notification enqueue + dedupe', () => {
  test('closeAuction enqueues WINNING for a lot it closes', async () => {
    const id = await mkAuction(new Date(Date.now() - 3600e3).toISOString());
    const lot = await addLot(id, 1);
    await addBid(id, lot, 5000);
    await db.query("UPDATE auctions SET state='active' WHERE id=$1", [id]);
    const before = await winningCount(BUYER);
    await auctionService.closeAuction(id);
    expect((await db.query('SELECT state, winning_buyer_user_id FROM lots WHERE id=$1', [lot])).rows[0]).toMatchObject({ state: 'closed', winning_buyer_user_id: BUYER });
    expect(await winningCount(BUYER)).toBe(before + 1);
  });
  test('closeAuction does NOT re-enqueue WINNING for a lot already closed (by per-lot auto-close)', async () => {
    const id = await mkAuction(new Date(Date.now() - 3600e3).toISOString());
    const lot = await addLot(id, 1);
    await addBid(id, lot, 7000);
    // simulate runLotAutoClose already closed it + already enqueued WINNING
    await db.query("UPDATE lots SET state='closed', winning_buyer_user_id=$1, winning_amount_cents=7000 WHERE id=$2", [BUYER, lot]);
    await db.query("INSERT INTO notifications_queue (user_id, type, payload) VALUES ($1,'WINNING',$2)", [BUYER, JSON.stringify({ lot_id: lot, visible_cents: 7000 })]);
    await db.query("UPDATE auctions SET state='active' WHERE id=$1", [id]);
    const before = await winningCount(BUYER);
    await auctionService.closeAuction(id);
    expect(await winningCount(BUYER)).toBe(before); // no double-email
  });
});

// Authoritative reserve enforcement: a lot sells ONLY if the top bid meets its reserve. Below-reserve →
// closes UNSOLD with no winner (so no invoice/payout/winner-notification). No reserve → behavior unchanged.
suite('RESERVE-1 authoritative reserve gate at close', () => {
  test('top bid BELOW reserve → lot closes UNSOLD (no winner, reserve_not_met, no WINNING email)', async () => {
    const id = await mkAuction(new Date(Date.now() - 3600e3).toISOString());
    const lot = await addLotWithReserve(id, 1, 10000); // reserve $100
    await addBid(id, lot, 6000);                        // top bid $60 — below reserve
    await db.query("UPDATE auctions SET state='active' WHERE id=$1", [id]);
    const before = await winningCount(BUYER);
    await auctionService.closeAuction(id);
    expect(await lotOutcome(lot)).toMatchObject({
      state: 'closed', winning_buyer_user_id: null, winning_amount_cents: null, reserve_not_met: true
    });
    expect(await winningCount(BUYER)).toBe(before);     // reserve-not-met never enters the winner path
  });

  test('top bid AT reserve → lot SELLS normally (winner assigned, reserve_not_met false)', async () => {
    const id = await mkAuction(new Date(Date.now() - 3600e3).toISOString());
    const lot = await addLotWithReserve(id, 1, 10000);
    await addBid(id, lot, 10000);                       // meets reserve exactly
    await db.query("UPDATE auctions SET state='active' WHERE id=$1", [id]);
    await auctionService.closeAuction(id);
    expect(await lotOutcome(lot)).toMatchObject({
      state: 'closed', winning_buyer_user_id: BUYER, winning_amount_cents: 10000, reserve_not_met: false
    });
  });

  test('NO reserve → winner logic unchanged (reserve_not_met stays false)', async () => {
    const id = await mkAuction(new Date(Date.now() - 3600e3).toISOString());
    const lot = await addLot(id, 1);                    // reserve_cents NULL
    await addBid(id, lot, 200);
    await db.query("UPDATE auctions SET state='active' WHERE id=$1", [id]);
    await auctionService.closeAuction(id);
    expect(await lotOutcome(lot)).toMatchObject({
      state: 'closed', winning_buyer_user_id: BUYER, winning_amount_cents: 200, reserve_not_met: false
    });
  });

  test('below-reserve unsold lot is Marketplace-eligible (authoritative UNSOLD, null winner)', async () => {
    const id = await mkAuction(new Date(Date.now() - 3600e3).toISOString());
    const lot = await addLotWithReserve(id, 1, 50000);
    await addBid(id, lot, 9000);
    await db.query("UPDATE auctions SET state='active' WHERE id=$1", [id]);
    await auctionService.closeAuction(id);
    // Same predicate marketplaceItemService.UNSOLD_JOIN uses: closed, not withdrawn, no winner, no payment.
    const eligible = (await db.query(
      `SELECT 1 FROM lots l WHERE l.id=$1 AND l.state='closed' AND l.is_withdrawn IS NOT TRUE
         AND l.winning_buyer_user_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.lot_id=l.id AND p.status IN ('pending','paid'))`,
      [lot])).rows[0];
    expect(eligible).toBeTruthy();
  });
});
