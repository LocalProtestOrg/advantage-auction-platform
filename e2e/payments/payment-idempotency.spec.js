import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

// These tests share a single lot and must not run in parallel
test.describe.configure({ mode: 'serial' });

const { Pool } = pg;

// ─── Config ────────────────────────────────────────────────────────────────

const LOT_ID      = process.env.TEST_LOT_ID;
const AUCTION_ID  = process.env.TEST_AUCTION_ID;
const AMOUNT_CENTS = parseInt(process.env.TEST_AMOUNT_CENTS || '7000', 10);

// ─── DB helpers ────────────────────────────────────────────────────────────

function getPool() {
  return new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME     || 'advantage_auction',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'admin123',
  });
}

async function cleanupPayments(lotId) {
  const pool = getPool();
  try {
    await pool.query('DELETE FROM payments WHERE lot_id = $1', [lotId]);
  } finally {
    await pool.end();
  }
}

async function countPayments(lotId) {
  const pool = getPool();
  try {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS count FROM payments WHERE lot_id = $1`,
      [lotId]
    );
    return parseInt(res.rows[0].count, 10);
  } finally {
    await pool.end();
  }
}

// ─── Auth helper ───────────────────────────────────────────────────────────

// Login response shape: { success: true, data: { token: "..." } }
async function loginAs(request, email, password) {
  const res = await request.post('/api/auth/login', { data: { email, password } });
  expect(res.status(), `Login failed for ${email}`).toBe(200);
  const body = await res.json();
  expect(body.success, 'Login response success flag').toBe(true);
  const token = body.data?.token;
  expect(token, 'JWT missing from login response').toBeTruthy();
  return token;
}

// ─── Setup: clean payment state before each test ───────────────────────────

test.beforeEach(async () => {
  await cleanupPayments(LOT_ID);
});

// ─── Test 1: Idempotency replay ─────────────────────────────────────────────
// Same key on the same lot returns the stored response without creating
// a second payment row.

test('payment idempotency - same key does not duplicate payment', async ({ request }) => {
  const token = await loginAs(request, 'buyer3@test.com', 'password123');
  const payload = { auction_id: AUCTION_ID, lot_id: LOT_ID, amount_cents: AMOUNT_CENTS };
  const idempotencyKey = `playwright-idem-${Date.now()}`;
  const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey };

  const res1 = await request.post('/api/payments/charge-lot', { data: payload, headers });
  expect(res1.status()).toBe(200);
  const body1 = await res1.json();

  const res2 = await request.post('/api/payments/charge-lot', { data: payload, headers });
  expect(res2.status()).toBe(200);
  const body2 = await res2.json();

  expect(body2).toEqual(body1);
});

// ─── Test 2: Business-rule duplicate block ──────────────────────────────────
// A second payment attempt on the same lot with a DIFFERENT idempotency key
// is rejected by the business rule — not by idempotency replay.

test('payment - duplicate attempt with new idempotency key is blocked', async ({ request }) => {
  const token = await loginAs(request, 'buyer3@test.com', 'password123');
  const payload = { auction_id: AUCTION_ID, lot_id: LOT_ID, amount_cents: AMOUNT_CENTS };
  const ts = Date.now();

  // First request — creates the payment
  const res1 = await request.post('/api/payments/charge-lot', {
    data: payload,
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `playwright-dup-a-${ts}` }
  });
  expect(res1.status()).toBe(200);

  // Second request — different key, same lot — blocked by business rule
  const res2 = await request.post('/api/payments/charge-lot', {
    data: payload,
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `playwright-dup-b-${ts}` }
  });
  expect(res2.status()).toBe(400);
  const body2 = await res2.json();
  expect(body2.success).toBe(false);
  expect(body2.message).toMatch(/Payment already exists/i);
});

// ─── Test 3: Race condition safety ──────────────────────────────────────────
// Two requests with the same idempotency key fired in parallel must not
// produce more than one payment row in the database.

test('payment - concurrent requests do not create duplicate payments', async ({ request }) => {
  const token = await loginAs(request, 'buyer3@test.com', 'password123');
  const payload = { auction_id: AUCTION_ID, lot_id: LOT_ID, amount_cents: AMOUNT_CENTS };
  const sharedKey = `playwright-race-${Date.now()}`;
  const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': sharedKey };

  // Fire both requests simultaneously
  const [res1, res2] = await Promise.all([
    request.post('/api/payments/charge-lot', { data: payload, headers }),
    request.post('/api/payments/charge-lot', { data: payload, headers }),
  ]);

  const status1 = res1.status();
  const status2 = res2.status();

  // At least one must succeed
  expect([status1, status2]).toContain(200);
  // Neither may be a server error
  expect(status1).toBeLessThan(500);
  expect(status2).toBeLessThan(500);

  // Critical: exactly one payment row in DB regardless of which request won
  const count = await countPayments(LOT_ID);
  expect(count).toBe(1);
});
