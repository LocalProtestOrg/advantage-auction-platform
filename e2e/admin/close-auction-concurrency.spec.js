import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

// Serial — tests share auction state and must not interleave
test.describe.configure({ mode: 'serial' });

const { Pool } = pg;

const AUCTION_ID  = '2eb81a2a-27aa-42fd-887b-bb343c48819d';
const ADMIN_EMAIL = 'tylerwitt2015@gmail.com';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const BUYER_EMAIL = 'buyer3@test.com';
const BUYER_PASS  = process.env.BUYER3_PASSWORD || 'password123';
const LOT_TITLE   = 'Close Concurrency Test Lot';
const CONCURRENT  = 5;

function getPool() {
  return new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
}

async function loginAs(request, email, password) {
  const res = await request.post('/api/auth/login', { data: { email, password } });
  expect(res.status(), `Login failed for ${email}`).toBe(200);
  const body = await res.json();
  return body.data.token;
}

// Remove test lots and reset auction to draft
async function resetState() {
  const pool = getPool();
  try {
    const lots = await pool.query(
      `SELECT id FROM lots WHERE auction_id = $1 AND title = $2`,
      [AUCTION_ID, LOT_TITLE]
    );
    for (const { id } of lots.rows) {
      await pool.query('DELETE FROM payments         WHERE lot_id = $1', [id]);
      await pool.query('DELETE FROM lot_proxy_bids   WHERE lot_id = $1', [id]);
      await pool.query('DELETE FROM bids             WHERE lot_id = $1', [id]);
      await pool.query('DELETE FROM lots             WHERE id     = $1', [id]);
    }
    await pool.query("DELETE FROM seller_payouts WHERE auction_id = $1", [AUCTION_ID]);
    await pool.query("UPDATE auctions SET status = 'draft' WHERE id = $1", [AUCTION_ID]);
  } finally {
    await pool.end();
  }
}

// ─── Test ──────────────────────────────────────────────────────────────────
test(`${CONCURRENT} concurrent close calls: exactly 1 succeeds, lot winner set once, 1 audit row`, async ({ request }) => {
  const testStartedAt = new Date();
  await resetState();

  const adminToken = await loginAs(request, ADMIN_EMAIL, ADMIN_PASS);
  const buyerToken = await loginAs(request, BUYER_EMAIL,  BUYER_PASS);

  // Create lot
  const lotRes = await request.post(`/api/auctions/${AUCTION_ID}/lots`, {
    data:    { title: LOT_TITLE, pickup_category: 'B' },
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(lotRes.status(), 'Lot creation failed').toBe(201);
  const lotId = (await lotRes.json()).data.id;

  // Publish — activates lots
  const pubRes = await request.patch(`/api/admin/auctions/${AUCTION_ID}/publish`, {
    headers: {
      Authorization:   `Bearer ${adminToken}`,
      'Idempotency-Key': `close-stress-pub-${Date.now()}`,
    },
  });
  expect(pubRes.status(), 'Publish failed').toBe(200);

  // Place a bid so the lot has a winner
  const bidRes = await request.post(`/api/lots/${lotId}/bids`, {
    data:    { amount: 50 },
    headers: { Authorization: `Bearer ${buyerToken}` },
  });
  expect(bidRes.status(), 'Bid failed').toBe(200);

  // ── Fire CONCURRENT close requests simultaneously ──────────────────────
  const results = await Promise.all(
    Array.from({ length: CONCURRENT }, () =>
      request.post(`/api/admin/auctions/${AUCTION_ID}/close`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    )
  );

  const statuses = results.map(r => r.status());
  const successes = statuses.filter(s => s === 200);
  const conflicts = statuses.filter(s => s === 409);

  expect(successes.length, `Expected exactly 1 success, got: ${statuses}`).toBe(1);
  expect(conflicts.length, `Expected ${CONCURRENT - 1} conflicts, got: ${statuses}`).toBe(CONCURRENT - 1);

  // ── DB assertions ─────────────────────────────────────────────────────
  const pool = getPool();
  try {
    // Auction status
    const { rows: [auction] } = await pool.query(
      `SELECT status FROM auctions WHERE id = $1`,
      [AUCTION_ID]
    );
    expect(auction.status, 'Auction must be closed').toBe('closed');

    // Lot closed with exactly one winner
    const { rows: [lot] } = await pool.query(
      `SELECT status, winning_buyer_user_id, winning_amount_cents FROM lots WHERE id = $1`,
      [lotId]
    );
    expect(lot.status,                'Lot must be closed').toBe('closed');
    expect(lot.winning_buyer_user_id, 'Winner must be set').toBeTruthy();
    expect(lot.winning_amount_cents,  'Winning amount must be positive').toBeGreaterThan(0);

    // Exactly one auction.closed audit row for this test run
    const { rows: [{ count: auditCount }] } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM audit_log
       WHERE event_type = 'auction.closed'
         AND auction_id = $1
         AND created_at >= $2`,
      [AUCTION_ID, testStartedAt]
    );
    expect(auditCount, 'Exactly one auction.closed audit row').toBe(1);

    // No duplicate bids from the close path (bids table unchanged by close)
    const { rows: [{ count: bidCount }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM bids WHERE lot_id = $1`,
      [lotId]
    );
    expect(bidCount, 'Bid count must be exactly 1').toBe(1);

    // Seller payout record created atomically with close (not fire-and-forget)
    const { rows: [payout] } = await pool.query(
      `SELECT gross_revenue_cents, platform_fee_cents, seller_payout_cents, payout_status
       FROM seller_payouts WHERE auction_id = $1`,
      [AUCTION_ID]
    );
    expect(payout, 'seller_payouts row must exist').toBeTruthy();
    expect(payout.payout_status, 'payout_status must be pending').toBe('pending');
    // With one bidder the visible price is the $1 starting bid (proxy max stays hidden).
    // 100 cents gross → 10 cents fee (10%) → 90 cents payout.
    expect(payout.gross_revenue_cents, 'gross_revenue_cents must be starting bid in cents').toBe(100);
    expect(payout.platform_fee_cents,  'platform_fee_cents must be 10% of gross').toBe(10);
    expect(payout.seller_payout_cents, 'seller_payout_cents must be gross minus fee').toBe(90);

  } finally {
    await pool.end();
  }
});

test.afterAll(resetState);
