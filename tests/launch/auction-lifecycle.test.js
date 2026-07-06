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
