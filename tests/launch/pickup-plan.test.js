'use strict';

/**
 * Launch — Buyer-Centric Global Pickup Scheduling Tier-1 tests.
 * Covers: A/B/C-only, mixed A+C→C, mixed A+B→B, multiple same-tier, unpaid (plan is
 * payment-independent), completion, missed/no-show, packet consistency, notification events.
 * Scratch-only. Skips unless PICKUP_SCRATCH=1 + non-prod DATABASE_URL.
 */

const SCRATCH_OK = !!process.env.PICKUP_SCRATCH && !/ep-proud-leaf/.test(process.env.DATABASE_URL || '');
if (!SCRATCH_OK) console.warn('[pickup-plan] SKIPPED — PICKUP_SCRATCH=1 + non-prod DATABASE_URL required.');
const suite = SCRATCH_OK ? describe : describe.skip;

const db = require('../../src/db');
const plan = require('../../src/services/pickupPlanService');
const { assignedTier } = require('../../src/lib/pickupTiers');

let AUCTION, ADMIN, B = {};
let stamp;
const mkUser = async (role) => (await db.query("INSERT INTO users (email, role, password_hash) VALUES ($1,$2,'x') RETURNING id", ['pk-' + role + '-' + (stamp++) + '@t.test', role])).rows[0].id;
const mkLot = async (buyer, size) => db.query(
  "INSERT INTO lots (auction_id, lot_number, title, size_category, state, winning_buyer_user_id, winning_amount_cents) VALUES ($1,$2,'L',$3,'closed',$4,1000)",
  [AUCTION, stamp++, size, buyer]);
const asg = async (buyer) => {
  const { rows } = await db.query(
    `SELECT count(*)::int lot_count, count(DISTINCT slot_start)::int slots, max(assigned_tier) tier, min(slot_start) slot_start, max(pickup_status) status
       FROM pickup_assignments WHERE buyer_user_id=$1`, [buyer]);
  return rows[0];
};
const winCount = async (buyer) => (await db.query("SELECT count(*)::int c FROM notifications_queue WHERE user_id=$1 AND type='PICKUP_SCHEDULED'", [buyer])).rows[0].c;

beforeAll(async () => {
  if (!SCRATCH_OK) return;
  stamp = Date.now() % 1000000;
  ADMIN = await mkUser('admin');
  const su = await mkUser('seller');
  const sp = (await db.query("INSERT INTO seller_profiles (user_id, seller_type) VALUES ($1,'private') RETURNING id", [su])).rows[0].id;
  const start = new Date(Date.now() + 2 * 86400e3).toISOString();
  const end = new Date(Date.now() + 2 * 86400e3 + 6 * 3600e3).toISOString();
  AUCTION = (await db.query("INSERT INTO auctions (seller_id, title, state, pickup_window_start, pickup_window_end) VALUES ($1,'PK','closed',$2,$3) RETURNING id", [sp, start, end])).rows[0].id;
  for (const k of ['A', 'B', 'C', 'AC', 'AB', 'C2']) B[k] = await mkUser('buyer');
  await mkLot(B.A, 'A');
  await mkLot(B.B, 'B');
  await mkLot(B.C, 'C');
  await mkLot(B.AC, 'A'); await mkLot(B.AC, 'C');
  await mkLot(B.AB, 'A'); await mkLot(B.AB, 'B');
  await mkLot(B.C2, 'C');
  const r = await plan.generatePlanAtClose(AUCTION);
  expect(r.ok).toBe(true);
});
afterAll(async () => { if (!SCRATCH_OK) return; await db.pool.end(); });

suite('buyer-centric tiering + consolidation', () => {
  test('A-only → tier A (1 slot)', async () => { const a = await asg(B.A); expect(a.tier).toBe('A'); expect(a.slots).toBe(1); });
  test('B-only → tier B', async () => { expect((await asg(B.B)).tier).toBe('B'); });
  test('C-only → tier C', async () => { expect((await asg(B.C)).tier).toBe('C'); });
  test('mixed A+C → ONE C-tier appointment (both lots, same slot)', async () => {
    const a = await asg(B.AC);
    expect(a.tier).toBe('C'); expect(a.lot_count).toBe(2); expect(a.slots).toBe(1);
  });
  test('mixed A+B → ONE B-tier appointment', async () => {
    const a = await asg(B.AB);
    expect(a.tier).toBe('B'); expect(a.lot_count).toBe(2); expect(a.slots).toBe(1);
  });
});

suite('global ordering + multiple same tier', () => {
  test('A tier before B before C in time', async () => {
    const a = await asg(B.A), b = await asg(B.B), c = await asg(B.C);
    expect(new Date(a.slot_start).getTime()).toBeLessThan(new Date(b.slot_start).getTime());
    expect(new Date(b.slot_start).getTime()).toBeLessThan(new Date(c.slot_start).getTime());
  });
  test('multiple C-tier buyers all scheduled in C tier', async () => {
    for (const k of ['C', 'AC', 'C2']) expect((await asg(B[k])).tier).toBe('C');
  });
});

suite('payment independence + notifications + packet consistency', () => {
  test('unpaid buyers are still assigned (plan is generated at close, not on payment)', async () => {
    // no payments were created for anyone; every buyer nonetheless has an appointment
    for (const k of Object.keys(B)) expect((await asg(B[k])).lot_count).toBeGreaterThanOrEqual(1);
  });
  test('one PICKUP_SCHEDULED notification enqueued per buyer', async () => {
    for (const k of Object.keys(B)) expect(await winCount(B[k])).toBe(1);
  });
  test('persisted assigned_tier matches the packet/display helper (assignedTier)', async () => {
    expect((await asg(B.AC)).tier).toBe(assignedTier(['A', 'C'])); // both = 'C'
    expect((await asg(B.AB)).tier).toBe(assignedTier(['A', 'B'])); // both = 'B'
  });
});

suite('completion + missed/no-show', () => {
  test('markCompleted completes all of a buyer\'s lots (one appointment)', async () => {
    const r = await plan.markCompleted(ADMIN, AUCTION, B.AC);
    expect(r.lots_completed).toBe(2);
    expect((await asg(B.AC)).status).toBe('completed');
  });
  test('non-admin cannot complete', async () => {
    await expect(plan.markCompleted(B.A, AUCTION, B.B)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('no-show is judged by the PUBLISHED window end (recommended slot is advisory)', async () => {
    // The recommended arrival window is advisory; a no-show only occurs once the whole
    // published pickup window has passed without completion.
    await db.query("UPDATE auctions SET pickup_window_end = now() - interval '1 hour' WHERE id=$1", [AUCTION]);
    const r = await plan.detectMissed();
    expect(r.marked).toBeGreaterThanOrEqual(1);
    expect((await asg(B.B)).status).toBe('missed');                 // still-scheduled buyer → missed
    expect((await asg(B.AC)).status).toBe('completed');             // completed buyer is NOT flagged
    expect((await db.query('SELECT count(*)::int c FROM missed_pickups WHERE buyer_user_id=$1', [B.B])).rows[0].c).toBeGreaterThanOrEqual(1);
  });
});
