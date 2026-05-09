import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const { Pool } = pg;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const ADMIN  = { email: process.env.TEST_ADMIN_EMAIL  || 'test-admin@example.com', password: process.env.TEST_ADMIN_PASSWORD || 'rehearsal123' };
const BUYER_A = { email: 'rehearsal-buyer-a@test.com', password: 'rehearsal123' };

// ── DB helpers ────────────────────────────────────────────────────────────────
let _pool;
function pool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return _pool;
}
async function dbQuery(sql, params = []) {
  const client = await pool().connect();
  try   { return (await client.query(sql, params)).rows; }
  finally { client.release(); }
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiLogin(request, creds) {
  const res  = await request.post(`${BASE}/api/auth/login`, { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}`).toBe(200);
  return body.token;
}

async function api(request, method, path, token, data) {
  const opts = { headers: { Authorization: `Bearer ${token}` } };
  if (data !== undefined) opts.data = data;
  const res = await request[method](`${BASE}${path}`, opts);
  return { status: res.status(), body: await res.json() };
}

// ── Shared state ──────────────────────────────────────────────────────────────
let adminToken, buyerAToken;
let buyerAUserId, sellerProfileId;
let testAuctionId, testLotId, testPaymentId;

test.beforeAll(async ({ request }) => {
  [adminToken, buyerAToken] = await Promise.all([
    apiLogin(request, ADMIN),
    apiLogin(request, BUYER_A),
  ]);

  const [buyerRows, spRows] = await Promise.all([
    dbQuery(`SELECT id FROM users WHERE email = $1`, [BUYER_A.email]),
    dbQuery(`SELECT sp.id FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE u.email = $1`,
      [process.env.TEST_SELLER_EMAIL || 'rehearsal-seller@test.com']),
  ]);

  buyerAUserId  = buyerRows[0].id;
  sellerProfileId = spRows[0].id;

  // Create a minimal draft auction + lot for the payment to reference.
  const auctionRows = await dbQuery(
    `INSERT INTO auctions (seller_id, title, state, created_at, updated_at)
     VALUES ($1, 'Refund Test Auction', 'draft', NOW(), NOW())
     RETURNING id`,
    [sellerProfileId]
  );
  testAuctionId = auctionRows[0].id;

  const lotRows = await dbQuery(
    `INSERT INTO lots (auction_id, title, state, lot_number, size_category, created_at, updated_at)
     VALUES ($1, 'Refund Test Lot', 'closed', 1, 'A', NOW(), NOW())
     RETURNING id`,
    [testAuctionId]
  );
  testLotId = lotRows[0].id;
});

test.afterAll(async () => {
  // Payments are cleaned up within each describe group; just remove the auction/lot.
  await dbQuery(`DELETE FROM payments WHERE lot_id = $1`, [testLotId]);
  if (testLotId)    await dbQuery(`DELETE FROM lots    WHERE id = $1`, [testLotId]);
  if (testAuctionId) await dbQuery(`DELETE FROM auctions WHERE id = $1`, [testAuctionId]);
  await pool().end();
});

// Helper: create a fresh paid payment for this test lot.
async function createPaidPayment(amountCents = 5000) {
  const rows = await dbQuery(
    `INSERT INTO payments (lot_id, buyer_user_id, amount_cents, status, created_at)
     VALUES ($1, $2, $3, 'paid', NOW())
     RETURNING id`,
    [testLotId, buyerAUserId, amountCents]
  );
  return rows[0].id;
}

// ── Auth guard tests ───────────────────────────────────────────────────────────
test.describe('Auth guards', () => {
  test('refund without token → 401', async ({ request }) => {
    const res = await request.post(`${BASE}/api/admin/payments/00000000-0000-4000-8000-000000000000/refund`, {
      data: { refund_amount_cents: 1000 },
    });
    expect(res.status()).toBe(401);
  });

  test('refund with buyer token → 403', async ({ request }) => {
    const { status } = await api(
      request, 'post',
      '/api/admin/payments/00000000-0000-4000-8000-000000000000/refund',
      buyerAToken,
      { refund_amount_cents: 1000 }
    );
    expect(status).toBe(403);
  });
});

// ── Validation tests ──────────────────────────────────────────────────────────
test.describe('Input validation', () => {
  test('missing refund_amount_cents → 400', async ({ request }) => {
    const { status, body } = await api(
      request, 'post',
      '/api/admin/payments/00000000-0000-4000-8000-000000000001/refund',
      adminToken,
      {}
    );
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('refund_amount_cents = 0 → 400', async ({ request }) => {
    const { status } = await api(
      request, 'post',
      '/api/admin/payments/00000000-0000-4000-8000-000000000001/refund',
      adminToken,
      { refund_amount_cents: 0 }
    );
    expect(status).toBe(400);
  });

  test('non-existent payment → 404', async ({ request }) => {
    const { status, body } = await api(
      request, 'post',
      '/api/admin/payments/00000000-0000-4000-8000-000000000099/refund',
      adminToken,
      { refund_amount_cents: 500 }
    );
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});

// ── Refund state guard ─────────────────────────────────────────────────────────
test.describe('Payment state guard', () => {
  test('refunding a pending payment → 422', async ({ request }) => {
    const [pendingRow] = await dbQuery(
      `INSERT INTO payments (lot_id, buyer_user_id, amount_cents, status, created_at)
       VALUES ($1, $2, 3000, 'pending', NOW())
       RETURNING id`,
      [testLotId, buyerAUserId]
    );
    const pendingId = pendingRow.id;

    const { status, body } = await api(
      request, 'post',
      `/api/admin/payments/${pendingId}/refund`,
      adminToken,
      { refund_amount_cents: 3000 }
    );
    expect(status).toBe(422);
    expect(body.message).toMatch(/Cannot refund/);

    await dbQuery(`DELETE FROM payments WHERE id = $1`, [pendingId]);
  });
});

// ── Full refund ───────────────────────────────────────────────────────────────
test.describe('Full refund', () => {
  test('full refund sets status to refunded', async ({ request }) => {
    testPaymentId = await createPaidPayment(4000);

    const { status, body } = await api(
      request, 'post',
      `/api/admin/payments/${testPaymentId}/refund`,
      adminToken,
      { refund_amount_cents: 4000 }
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.payment_id).toBe(testPaymentId);
    expect(body.data.status).toBe('refunded');
    expect(body.data.refund_amount_cents).toBe(4000);
    expect(body.data.refunded_at).toBeTruthy();
  });

  test('DB reflects refunded status after full refund', async () => {
    const rows = await dbQuery(
      `SELECT status, refunded_at FROM payments WHERE id = $1`,
      [testPaymentId]
    );
    expect(rows[0].status).toBe('refunded');
    expect(rows[0].refunded_at).toBeTruthy();
  });

  test('refunding an already-refunded payment → 422', async ({ request }) => {
    const { status, body } = await api(
      request, 'post',
      `/api/admin/payments/${testPaymentId}/refund`,
      adminToken,
      { refund_amount_cents: 4000 }
    );
    expect(status).toBe(422);
    expect(body.message).toMatch(/Cannot refund/);
  });

  test.afterAll(async () => {
    if (testPaymentId) await dbQuery(`DELETE FROM payments WHERE id = $1`, [testPaymentId]);
  });
});

// ── Partial refund ────────────────────────────────────────────────────────────
test.describe('Partial refund', () => {
  let partialPaymentId;

  test('partial refund sets status to partially_refunded', async ({ request }) => {
    partialPaymentId = await createPaidPayment(10000);

    const { status, body } = await api(
      request, 'post',
      `/api/admin/payments/${partialPaymentId}/refund`,
      adminToken,
      { refund_amount_cents: 3000 }
    );
    expect(status).toBe(200);
    expect(body.data.status).toBe('partially_refunded');
    expect(body.data.refund_amount_cents).toBe(3000);
  });

  test('DB reflects partially_refunded status', async () => {
    const rows = await dbQuery(
      `SELECT status FROM payments WHERE id = $1`,
      [partialPaymentId]
    );
    expect(rows[0].status).toBe('partially_refunded');
    await dbQuery(`DELETE FROM payments WHERE id = $1`, [partialPaymentId]);
  });

  test('refund amount exceeding payment amount → 422', async ({ request }) => {
    const overPaymentId = await createPaidPayment(2000);  // fresh paid payment
    const { status, body } = await api(
      request, 'post',
      `/api/admin/payments/${overPaymentId}/refund`,
      adminToken,
      { refund_amount_cents: 5000 }
    );
    expect(status).toBe(422);
    expect(body.message).toMatch(/Refund amount/);
    await dbQuery(`DELETE FROM payments WHERE id = $1`, [overPaymentId]);
  });
});
