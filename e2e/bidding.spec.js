import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

// All tests share DB state through a single lot — run serially.
test.describe.configure({ mode: 'serial' });

const { Pool } = pg;

// ── Config ────────────────────────────────────────────────────────────────────
// Seed these in .env or supply real values for a running test DB.
//
//   TEST_AUCTION_ID   — a closed auction with winning_buyer_user_id set on the lot
//   TEST_LOT_ID       — the lot inside that auction (status=closed for payment tests)
//   TEST_ACTIVE_LOT_ID — a separate lot with status=active for bid tests
//   TEST_BUYER_1/2/3_EMAIL + _PASSWORD — three buyer accounts
//   TEST_NONWINNER_EMAIL + _PASSWORD   — a buyer who did NOT win TEST_LOT_ID

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const AUCTION_ID        = process.env.TEST_AUCTION_ID;
const LOT_ID            = process.env.TEST_LOT_ID;          // closed lot
const ACTIVE_LOT_ID     = process.env.TEST_ACTIVE_LOT_ID;  // active lot for bid tests

const BUYER = [
  { email: process.env.TEST_BUYER_1_EMAIL    || 'buyer1@test.com', password: process.env.TEST_BUYER_1_PASSWORD    || 'password123' },
  { email: process.env.TEST_BUYER_2_EMAIL    || 'buyer2@test.com', password: process.env.TEST_BUYER_2_PASSWORD    || 'password123' },
  { email: process.env.TEST_BUYER_3_EMAIL    || 'buyer3@test.com', password: process.env.TEST_BUYER_3_PASSWORD    || 'password123' },
];
const NONWINNER = {
  email:    process.env.TEST_NONWINNER_EMAIL    || 'nonwinner@test.com',
  password: process.env.TEST_NONWINNER_PASSWORD || 'password123',
};

// ── DB helpers ────────────────────────────────────────────────────────────────
function pool() {
  return new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME     || 'advantage_auction',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'admin123',
  });
}

async function dbQuery(sql, params = []) {
  const p = pool();
  try   { return (await p.query(sql, params)).rows; }
  finally { await p.end(); }
}

async function getLot(lotId) {
  const rows = await dbQuery('SELECT * FROM lots WHERE id = $1', [lotId]);
  return rows[0] ?? null;
}

async function cleanBids(lotId) {
  await dbQuery('DELETE FROM bids           WHERE lot_id = $1', [lotId]);
  await dbQuery('DELETE FROM lot_proxy_bids WHERE lot_id = $1', [lotId]);
  await dbQuery(
    `UPDATE lots SET current_bid_cents = 0, current_price = 0, current_winner_user_id = NULL
     WHERE id = $1`,
    [lotId]
  );
}

async function cleanPayments(lotId) {
  await dbQuery('DELETE FROM payments WHERE lot_id = $1', [lotId]);
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function login(request, { email, password }) {
  const res  = await request.post('/api/auth/login', { data: { email, password } });
  const body = await res.json();
  expect(res.status(), `Login failed for ${email}: ${body.message}`).toBe(200);
  expect(body.data?.token, 'JWT missing').toBeTruthy();
  return body.data.token;
}

async function placeBid(request, token, lotId, amountCents) {
  return request.post(`/api/lots/${lotId}/bids`, {
    data:    { max_bid_cents: amountCents },
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function chargeLot(request, token, lotId, auctionId, key) {
  return request.post('/api/payments/charge-lot', {
    data:    { lot_id: lotId, auction_id: auctionId },
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MULTI-USER BIDDING
// Three buyers submit escalating proxy bids.
// The buyer with the highest max wins and the visible price is set correctly.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Multi-user bidding', () => {
  test.beforeAll(async () => { await cleanBids(ACTIVE_LOT_ID); });

  test('highest proxy bid wins', async ({ request }) => {
    const [t1, t2, t3] = await Promise.all(BUYER.map(b => login(request, b)));

    // Buyer 1 — 1000 cents
    const r1 = await placeBid(request, t1, ACTIVE_LOT_ID, 1000);
    expect(r1.status(), 'Buyer 1 bid rejected').toBe(200);

    // Buyer 2 — 2000 cents (outbids buyer 1)
    const r2 = await placeBid(request, t2, ACTIVE_LOT_ID, 2000);
    expect(r2.status(), 'Buyer 2 bid rejected').toBe(200);

    // Buyer 3 — 5000 cents (highest — should win)
    const r3 = await placeBid(request, t3, ACTIVE_LOT_ID, 5000);
    expect(r3.status(), 'Buyer 3 bid rejected').toBe(200);
    const b3 = await r3.json();
    expect(b3.success).toBe(true);

    // DB state: winner is buyer 3, visible price ≥ 2000 + increment
    const lot = await getLot(ACTIVE_LOT_ID);
    const buyerRow = await dbQuery('SELECT id FROM users WHERE email = $1', [BUYER[2].email]);
    expect(lot.current_winner_user_id).toBe(buyerRow[0].id);
    // Visible price must be above the second-highest max (2000)
    expect(lot.current_bid_cents).toBeGreaterThan(2000);
    // ...and at most buyer 3's max
    expect(lot.current_bid_cents).toBeLessThanOrEqual(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ANTI-SNIPING
// A bid placed when closes_at is within 60 s must extend closes_at by 60 s.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Anti-sniping', () => {
  test('bid in final 60s extends closes_at', async ({ request }) => {
    // Force the lot to close in 30 s so the next bid triggers anti-snipe.
    await dbQuery(
      `UPDATE lots SET closes_at = now() + interval '30 seconds', status = 'active'
       WHERE id = $1`,
      [ACTIVE_LOT_ID]
    );

    const lotBefore = await getLot(ACTIVE_LOT_ID);
    const closesBefore = new Date(lotBefore.closes_at).getTime();

    const token = await login(request, BUYER[0]);
    // Use a higher amount than the current winner to guarantee acceptance
    const currentBid  = lotBefore.current_bid_cents || 0;
    const bidAmount   = currentBid + 1000;
    const res = await placeBid(request, token, ACTIVE_LOT_ID, bidAmount);
    expect(res.status(), 'Anti-snipe bid rejected').toBe(200);

    const lotAfter  = await getLot(ACTIVE_LOT_ID);
    const closesAfter = new Date(lotAfter.closes_at).getTime();

    // closes_at must have increased by ~60 s (allow ±2 s for clock skew)
    const delta = closesAfter - closesBefore;
    expect(delta).toBeGreaterThanOrEqual(58_000);
    expect(delta).toBeLessThanOrEqual(62_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PAYMENT GUARDS
// Uses a closed lot with a known winner.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Payment guards', () => {
  test.beforeEach(async () => { await cleanPayments(LOT_ID); });

  test('non-winner cannot pay', async ({ request }) => {
    const token = await login(request, NONWINNER);
    const res   = await chargeLot(request, token, LOT_ID, AUCTION_ID, `nonwinner-${Date.now()}`);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/only winning bidder/i);
  });

  test('winner can pay', async ({ request }) => {
    // Determine which buyer won from the DB directly
    const [lotRow] = await dbQuery('SELECT winning_buyer_user_id FROM lots WHERE id = $1', [LOT_ID]);
    expect(lotRow, 'TEST_LOT_ID has no winner — seed the DB').toBeTruthy();

    const [winnerRow] = await dbQuery('SELECT email FROM users WHERE id = $1', [lotRow.winning_buyer_user_id]);
    const winnerCreds = BUYER.find(b => b.email === winnerRow.email) ??
                        { email: winnerRow.email, password: 'password123' };

    const token = await login(request, winnerCreds);
    const res   = await chargeLot(request, token, LOT_ID, AUCTION_ID, `winner-pay-${Date.now()}`);
    expect(res.status(), (await res.json()).message).toBe(200);
    const body  = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.client_secret).toBeTruthy();
  });

  test('duplicate payment on same lot is blocked', async ({ request }) => {
    const [lotRow] = await dbQuery('SELECT winning_buyer_user_id FROM lots WHERE id = $1', [LOT_ID]);
    const [winnerRow] = await dbQuery('SELECT email FROM users WHERE id = $1', [lotRow.winning_buyer_user_id]);
    const winnerCreds = BUYER.find(b => b.email === winnerRow.email) ??
                        { email: winnerRow.email, password: 'password123' };

    const token = await login(request, winnerCreds);
    const ts    = Date.now();

    // First payment succeeds
    const r1 = await chargeLot(request, token, LOT_ID, AUCTION_ID, `dup-a-${ts}`);
    expect(r1.status()).toBe(200);

    // Second payment with a different key must be rejected by business rule
    const r2 = await chargeLot(request, token, LOT_ID, AUCTION_ID, `dup-b-${ts}`);
    expect(r2.status()).toBe(400);
    const body2 = await r2.json();
    expect(body2.success).toBe(false);
    expect(body2.message).toMatch(/payment already exists/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. IDEMPOTENCY
// Same Idempotency-Key twice must return an identical stored response.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Idempotency', () => {
  test.beforeEach(async () => { await cleanPayments(LOT_ID); });

  test('same key returns identical response', async ({ request }) => {
    const [lotRow] = await dbQuery('SELECT winning_buyer_user_id FROM lots WHERE id = $1', [LOT_ID]);
    const [winnerRow] = await dbQuery('SELECT email FROM users WHERE id = $1', [lotRow.winning_buyer_user_id]);
    const winnerCreds = BUYER.find(b => b.email === winnerRow.email) ??
                        { email: winnerRow.email, password: 'password123' };

    const token = await login(request, winnerCreds);
    const key   = `idem-replay-${Date.now()}`;

    const r1 = await chargeLot(request, token, LOT_ID, AUCTION_ID, key);
    expect(r1.status()).toBe(200);
    const body1 = await r1.json();

    const r2 = await chargeLot(request, token, LOT_ID, AUCTION_ID, key);
    expect(r2.status()).toBe(200);
    const body2 = await r2.json();

    // Entire response body must be byte-for-byte identical
    expect(body2).toEqual(body1);

    // DB must contain exactly one payment row
    const rows = await dbQuery('SELECT COUNT(*)::int AS n FROM payments WHERE lot_id = $1', [LOT_ID]);
    expect(rows[0].n).toBe(1);
  });

  test('missing Idempotency-Key header returns 400', async ({ request }) => {
    const token = await login(request, BUYER[0]);
    const res = await request.post('/api/payments/charge-lot', {
      data:    { lot_id: LOT_ID, auction_id: AUCTION_ID },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/idempotency-key/i);
  });

  test('concurrent requests with same key produce exactly one payment', async ({ request }) => {
    const [lotRow] = await dbQuery('SELECT winning_buyer_user_id FROM lots WHERE id = $1', [LOT_ID]);
    const [winnerRow] = await dbQuery('SELECT email FROM users WHERE id = $1', [lotRow.winning_buyer_user_id]);
    const winnerCreds = BUYER.find(b => b.email === winnerRow.email) ??
                        { email: winnerRow.email, password: 'password123' };

    const token = await login(request, winnerCreds);
    const key   = `idem-race-${Date.now()}`;

    const [r1, r2] = await Promise.all([
      chargeLot(request, token, LOT_ID, AUCTION_ID, key),
      chargeLot(request, token, LOT_ID, AUCTION_ID, key),
    ]);

    expect(r1.status()).toBeLessThan(500);
    expect(r2.status()).toBeLessThan(500);
    expect([r1.status(), r2.status()]).toContain(200);

    const rows = await dbQuery('SELECT COUNT(*)::int AS n FROM payments WHERE lot_id = $1', [LOT_ID]);
    expect(rows[0].n).toBe(1);
  });
});
