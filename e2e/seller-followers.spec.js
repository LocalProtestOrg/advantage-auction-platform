import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const { Pool } = pg;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const ADMIN  = { email: process.env.TEST_ADMIN_EMAIL    || 'test-admin@example.com', password: process.env.TEST_ADMIN_PASSWORD || 'rehearsal123' };
const SELLER = { email: process.env.TEST_SELLER_EMAIL   || 'rehearsal-seller@test.com',  password: 'rehearsal123' };
const BUYER_A = { email: 'rehearsal-buyer-a@test.com',  password: 'rehearsal123' };
const BUYER_B = { email: 'rehearsal-buyer-b@test.com',  password: 'rehearsal123' };

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
  const res  = await request[method](`${BASE}${path}`, opts);
  return { status: res.status(), body: await res.json() };
}

// ── Shared state ──────────────────────────────────────────────────────────────
let adminToken, sellerToken, buyerAToken, buyerBToken;
let sellerProfileId;
let testAuctionId;

test.beforeAll(async ({ request }) => {
  [adminToken, sellerToken, buyerAToken, buyerBToken] = await Promise.all([
    apiLogin(request, ADMIN),
    apiLogin(request, SELLER),
    apiLogin(request, BUYER_A),
    apiLogin(request, BUYER_B),
  ]);

  // Resolve seller_profiles.id from the seller's user record.
  const rows = await dbQuery(
    `SELECT sp.id
       FROM seller_profiles sp
       JOIN users u ON u.id = sp.user_id
      WHERE u.email = $1`,
    [SELLER.email]
  );
  expect(rows.length, 'Seller profile must exist').toBeGreaterThan(0);
  sellerProfileId = rows[0].id;

  // Clean up any stale follower rows from previous test runs.
  await dbQuery(
    `DELETE FROM seller_followers WHERE seller_id = $1`,
    [sellerProfileId]
  );
});

test.afterAll(async () => {
  // Remove follower rows created during tests.
  await dbQuery(
    `DELETE FROM seller_followers WHERE seller_id = $1`,
    [sellerProfileId]
  );

  // Remove test auction and its notifications.
  if (testAuctionId) {
    await dbQuery(
      `DELETE FROM notifications_queue
        WHERE payload->>'auction_id' = $1`,
      [testAuctionId]
    );
    await dbQuery(`DELETE FROM lots    WHERE auction_id = $1`, [testAuctionId]);
    await dbQuery(`DELETE FROM auctions WHERE id         = $1`, [testAuctionId]);
  }

  await pool().end();
});

// ── Phase 1: Follow / unfollow ────────────────────────────────────────────────
test.describe('Follow / unfollow', () => {
  test('buyer can follow a seller', async ({ request }) => {
    const { status, body } = await api(request, 'post', `/api/sellers/${sellerProfileId}/follow`, buyerAToken);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('follow is idempotent — second call returns 200, count unchanged', async ({ request }) => {
    const { status, body } = await api(request, 'post', `/api/sellers/${sellerProfileId}/follow`, buyerAToken);
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const { body: countBody } = await api(request, 'get', `/api/sellers/${sellerProfileId}/followers/count`, buyerAToken);
    expect(countBody.data.count).toBe(1);
  });

  test('follower count reflects single follow', async ({ request }) => {
    const { status, body } = await api(request, 'get', `/api/sellers/${sellerProfileId}/followers/count`, null);
    expect(status).toBe(200);
    expect(body.data.seller_id).toBe(sellerProfileId);
    expect(body.data.count).toBe(1);
  });

  test('following list shows the followed seller', async ({ request }) => {
    const { status, body } = await api(request, 'get', '/api/sellers/following', buyerAToken);
    expect(status).toBe(200);
    expect(body.data.length).toBe(1);
    expect(body.data[0].seller_id).toBe(sellerProfileId);
    expect(body.data[0]).toHaveProperty('seller_email');
    expect(body.data[0]).toHaveProperty('followed_at');
    expect(body.data[0]).toHaveProperty('active_auction_count');
  });

  test('buyer B following list is empty', async ({ request }) => {
    const { status, body } = await api(request, 'get', '/api/sellers/following', buyerBToken);
    expect(status).toBe(200);
    expect(body.data.length).toBe(0);
  });

  test('buyer can unfollow a seller', async ({ request }) => {
    const { status, body } = await api(request, 'delete', `/api/sellers/${sellerProfileId}/follow`, buyerAToken);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('unfollow is idempotent — second delete returns 200', async ({ request }) => {
    const { status, body } = await api(request, 'delete', `/api/sellers/${sellerProfileId}/follow`, buyerAToken);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('follower count returns to zero after unfollow', async ({ request }) => {
    const { body } = await api(request, 'get', `/api/sellers/${sellerProfileId}/followers/count`, null);
    expect(body.data.count).toBe(0);
  });

  test('following list is empty after unfollow', async ({ request }) => {
    const { body } = await api(request, 'get', '/api/sellers/following', buyerAToken);
    expect(body.data.length).toBe(0);
  });
});

// ── Phase 2: Auth guards ───────────────────────────────────────────────────────
test.describe('Auth guards', () => {
  test('follow without token → 401', async ({ request }) => {
    const res = await request.post(`${BASE}/api/sellers/${sellerProfileId}/follow`);
    expect(res.status()).toBe(401);
  });

  test('unfollow without token → 401', async ({ request }) => {
    const res = await request.delete(`${BASE}/api/sellers/${sellerProfileId}/follow`);
    expect(res.status()).toBe(401);
  });

  test('following list without token → 401', async ({ request }) => {
    const res = await request.get(`${BASE}/api/sellers/following`);
    expect(res.status()).toBe(401);
  });

  test('follower count is public — no token required', async ({ request }) => {
    const res = await request.get(`${BASE}/api/sellers/${sellerProfileId}/followers/count`);
    expect(res.status()).toBe(200);
  });

  test('follow nonexistent seller → 404', async ({ request }) => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status } = await api(request, 'post', `/api/sellers/${fakeId}/follow`, buyerAToken);
    expect(status).toBe(404);
  });
});

// ── Phase 3: NEW_AUCTION notification trigger ──────────────────────────────────
test.describe('NEW_AUCTION notification on publish', () => {
  test('setup: buyer A follows seller, buyer B does not', async ({ request }) => {
    await api(request, 'post', `/api/sellers/${sellerProfileId}/follow`, buyerAToken);
    // buyer B has never followed — confirmed by Phase 1 tests above.
    const { body } = await api(request, 'get', `/api/sellers/${sellerProfileId}/followers/count`, null);
    expect(body.data.count).toBe(1);
  });

  test('setup: create a draft auction directly in DB', async () => {
    const rows = await dbQuery(
      `INSERT INTO auctions (seller_id, title, state, created_at, updated_at)
       VALUES ($1, 'Follower Notification Test Auction', 'draft', NOW(), NOW())
       RETURNING id`,
      [sellerProfileId]
    );
    testAuctionId = rows[0].id;
    expect(testAuctionId).toBeTruthy();
  });

  test('admin publishing an auction enqueues NEW_AUCTION for follower', async ({ request }) => {
    const { status, body } = await api(
      request, 'patch',
      `/api/admin/auctions/${testAuctionId}/publish`,
      adminToken
    );
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.data.state).toBe('published');

    // Allow the async fan-out to complete (it fires after response).
    // Use 1500ms here — the test suite runs serially, and prior browser-based
    // specs leave in-flight server requests that temporarily exhaust the DB pool.
    await new Promise(r => setTimeout(r, 1500));

    const notifs = await dbQuery(
      `SELECT nq.user_id, nq.type, nq.payload
         FROM notifications_queue nq
         JOIN users u ON u.id = nq.user_id
        WHERE nq.type               = 'NEW_AUCTION'
          AND nq.payload->>'auction_id' = $1`,
      [testAuctionId]
    );

    expect(notifs.length).toBeGreaterThanOrEqual(1);

    const buyerANotif = notifs.find(n => {
      // Match by looking up buyer A's user_id
      return true; // refined below
    });

    // Verify at least one notification targets buyer A.
    const buyerARows = await dbQuery(
      `SELECT id FROM users WHERE email = $1`,
      [BUYER_A.email]
    );
    const buyerAUserId = buyerARows[0].id;
    const forBuyerA = notifs.find(n => n.user_id === buyerAUserId);
    expect(forBuyerA, 'Buyer A should receive NEW_AUCTION notification').toBeTruthy();
    expect(forBuyerA.payload.title).toBe('Follower Notification Test Auction');
    expect(forBuyerA.payload.auction_id).toBe(testAuctionId);
    expect(forBuyerA.payload.seller_id).toBe(sellerProfileId);
    expect(forBuyerA.payload).toHaveProperty('auction_url');
  });

  test('buyer B (non-follower) receives no NEW_AUCTION notification', async () => {
    const buyerBRows = await dbQuery(
      `SELECT id FROM users WHERE email = $1`,
      [BUYER_B.email]
    );
    const buyerBUserId = buyerBRows[0].id;

    const notifs = await dbQuery(
      `SELECT id FROM notifications_queue
        WHERE type = 'NEW_AUCTION'
          AND user_id = $1
          AND payload->>'auction_id' = $2`,
      [buyerBUserId, testAuctionId]
    );
    expect(notifs.length).toBe(0);
  });

  test('publish failure does not create NEW_AUCTION notifications', async ({ request }) => {
    // Attempting to publish an already-published auction → 409, no new notifications.
    const countBefore = (await dbQuery(
      `SELECT COUNT(*)::int AS c FROM notifications_queue WHERE type = 'NEW_AUCTION' AND payload->>'auction_id' = $1`,
      [testAuctionId]
    ))[0].c;

    const { status } = await api(
      request, 'patch',
      `/api/admin/auctions/${testAuctionId}/publish`,
      adminToken
    );
    expect(status).toBe(409);

    await new Promise(r => setTimeout(r, 200));

    const countAfter = (await dbQuery(
      `SELECT COUNT(*)::int AS c FROM notifications_queue WHERE type = 'NEW_AUCTION' AND payload->>'auction_id' = $1`,
      [testAuctionId]
    ))[0].c;

    expect(countAfter).toBe(countBefore);
  });
});
