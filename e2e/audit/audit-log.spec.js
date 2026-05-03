import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

// All 4 tests share auction + lot state — must run serially
test.describe.configure({ mode: 'serial' });

const { Pool } = pg;

// ─── Config ────────────────────────────────────────────────────────────────
const AUCTION_ID  = '2eb81a2a-27aa-42fd-887b-bb343c48819d';
const ADMIN_EMAIL = 'tylerwitt2015@gmail.com';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const BUYER_EMAIL = 'buyer3@test.com';
const BUYER_PASS  = process.env.BUYER3_PASSWORD || 'password123';

// ─── DB helpers ────────────────────────────────────────────────────────────
function getPool() {
  return new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
}

async function queryAuditLog(eventType, auctionId) {
  const pool = getPool();
  try {
    const res = await pool.query(
      `SELECT * FROM audit_log
       WHERE event_type = $1 AND auction_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [eventType, auctionId]
    );
    return res.rows[0] || null;
  } finally {
    await pool.end();
  }
}

async function resetAuctionState(auctionId) {
  const pool = getPool();
  try {
    // Delete lots created by previous test runs under this auction
    const lots = await pool.query(
      `SELECT id FROM lots WHERE auction_id = $1 AND title = 'Audit Test Lot'`,
      [auctionId]
    );
    for (const lot of lots.rows) {
      await pool.query('DELETE FROM payments WHERE lot_id = $1', [lot.id]);
      await pool.query('DELETE FROM bids WHERE lot_id = $1', [lot.id]);
      await pool.query('DELETE FROM lots WHERE id = $1', [lot.id]);
    }
    await pool.query("UPDATE auctions SET status = 'draft' WHERE id = $1", [auctionId]);
  } finally {
    await pool.end();
  }
}

async function cleanupLot(lotId) {
  const pool = getPool();
  try {
    await pool.query('DELETE FROM payments WHERE lot_id = $1', [lotId]);
    await pool.query('DELETE FROM bids WHERE lot_id = $1', [lotId]);
    await pool.query('DELETE FROM lots WHERE id = $1', [lotId]);
  } finally {
    await pool.end();
  }
}

// ─── Auth helper ───────────────────────────────────────────────────────────
async function loginAs(request, email, password) {
  const res = await request.post('/api/auth/login', { data: { email, password } });
  expect(res.status(), `Login failed for ${email}`).toBe(200);
  const body = await res.json();
  const token = body.data?.token;
  expect(token, 'JWT missing from login response').toBeTruthy();
  return token;
}

// ─── Shared state (populated in beforeAll, read by tests) ──────────────────
let adminToken;
let buyerToken;
let lotId;
let paymentId;

// ─── Setup ─────────────────────────────────────────────────────────────────
test.beforeAll(async ({ request }) => {
  // Reset auction to draft and clear any prior test lot artifacts
  await resetAuctionState(AUCTION_ID);

  adminToken = await loginAs(request, ADMIN_EMAIL, ADMIN_PASS);
  buyerToken  = await loginAs(request, BUYER_EMAIL,  BUYER_PASS);

  // Create a fresh lot under the draft auction
  const lotRes = await request.post(`/api/auctions/${AUCTION_ID}/lots`, {
    data: { title: 'Audit Test Lot', pickup_category: 'B' },
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  expect(lotRes.status(), 'Lot creation failed').toBe(201);
  const lotBody = await lotRes.json();
  lotId = lotBody.data.id;

  // Publish the auction (required before bids can be placed)
  const publishRes = await request.patch(`/api/admin/auctions/${AUCTION_ID}/publish`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  expect(publishRes.status(), 'Publish auction failed').toBe(200);

  // Place a bid as buyer so the lot has a winner after close
  const bidRes = await request.post(`/api/lots/${lotId}/bids`, {
    data: { amount: 25 },
    headers: { Authorization: `Bearer ${buyerToken}` }
  });
  expect(bidRes.status(), 'Bid placement failed').toBe(200);
});

test.afterAll(async () => {
  const pool = getPool();
  try {
    if (lotId) await cleanupLot(lotId);
    await pool.query("UPDATE auctions SET status = 'draft' WHERE id = $1", [AUCTION_ID]);
  } finally {
    await pool.end();
  }
});

// ─── Test 1: auction.published ─────────────────────────────────────────────
// Publish happened in beforeAll — verify the audit row was written
test('audit_log records auction.published', async () => {
  const row = await queryAuditLog('auction.published', AUCTION_ID);
  expect(row, 'Expected auction.published row in audit_log').not.toBeNull();
  expect(row.entity_type).toBe('auction');
  expect(row.entity_id).toBe(AUCTION_ID);
  expect(row.actor_id).toBeTruthy();
});

// ─── Test 2: auction.closed ─────────────────────────────────────────────────
test('audit_log records auction.closed', async ({ request }) => {
  const res = await request.post(`/api/admin/auctions/${AUCTION_ID}/close`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  expect(res.status(), 'Close auction failed').toBe(200);

  const row = await queryAuditLog('auction.closed', AUCTION_ID);
  expect(row, 'Expected auction.closed row in audit_log').not.toBeNull();
  expect(row.entity_type).toBe('auction');
  expect(row.metadata.lots_closed).toBeGreaterThanOrEqual(1);
});

// ─── Test 3: payment.created ────────────────────────────────────────────────
test('audit_log records payment.created', async ({ request }) => {
  test.setTimeout(45_000);
  const res = await request.post('/api/payments/charge-lot', {
    data: { auction_id: AUCTION_ID, lot_id: lotId },
    headers: {
      Authorization: `Bearer ${buyerToken}`,
      'Idempotency-Key': `audit-test-${Date.now()}`
    }
  });
  expect(res.status(), 'Charge lot failed').toBe(200);
  const body = await res.json();
  paymentId = body.data.id;

  const row = await queryAuditLog('payment.created', AUCTION_ID);
  expect(row, 'Expected payment.created row in audit_log').not.toBeNull();
  expect(row.lot_id).toBe(lotId);
  expect(row.payment_id).toBe(paymentId);
  expect(row.actor_id).toBeTruthy();
});

// ─── Test 4: payment.paid ───────────────────────────────────────────────────
test('audit_log records payment.paid', async ({ request }) => {
  const res = await request.post(`/api/admin/payments/${paymentId}/record-success`, {
    data: { payment_provider_id: 'test-provider-001' },
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  expect(res.status(), 'Record payment success failed').toBe(200);

  const row = await queryAuditLog('payment.paid', AUCTION_ID);
  expect(row, 'Expected payment.paid row in audit_log').not.toBeNull();
  expect(row.payment_id).toBe(paymentId);
  expect(row.metadata.payment_provider_id).toBe('test-provider-001');
});
