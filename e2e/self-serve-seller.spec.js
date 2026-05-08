import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

// All tests share state — run serially.
test.describe.configure({ mode: 'serial' });

const { Pool } = pg;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const SELLER = {
  email:    process.env.TEST_SELLER_EMAIL    || 'rehearsal-seller@test.com',
  password: process.env.TEST_SELLER_PASSWORD || 'rehearsal123',
};
const ADMIN = {
  email:    process.env.TEST_ADMIN_EMAIL    || 'test-admin@example.com',
  password: process.env.TEST_ADMIN_PASSWORD || 'rehearsal123',
};
const BUYER = {
  email:    process.env.TEST_BUYER_1_EMAIL    || 'rehearsal-buyer-a@test.com',
  password: process.env.TEST_BUYER_1_PASSWORD || 'rehearsal123',
};

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
async function login(request, creds) {
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}: ${body.message}`).toBe(200);
  expect(body.token, 'JWT missing').toBeTruthy();
  return body.token;
}

async function getSellerProfile(request, token) {
  const res  = await request.get('/api/sellers/me', { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  expect(res.status()).toBe(200);
  return body.data;
}

async function createAuction(request, token, payload) {
  const res  = await request.post('/api/auctions', {
    data:    payload,
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  expect(res.status(), `Create auction failed: ${body.message}`).toBe(201);
  return body.data;
}

async function createLot(request, token, auctionId, payload) {
  const res  = await request.post(`/api/auctions/${auctionId}/lots`, {
    data:    payload,
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  expect(res.status(), `Create lot failed: ${body.message}`).toBe(201);
  return body.data;
}

async function adminPublish(request, token, auctionId) {
  const res  = await request.patch(`/api/admin/auctions/${auctionId}/publish`, {
    data:    {},
    headers: {
      Authorization:     `Bearer ${token}`,
      'Idempotency-Key': `publish-selfserve-${auctionId}-${Date.now()}`,
    },
  });
  const body = await res.json();
  expect(res.status(), `Publish failed: ${body.message}`).toBe(200);
  return body.data;
}

async function adminClose(request, token, auctionId) {
  const res  = await request.post(`/api/admin/auctions/${auctionId}/close`, {
    data:    {},
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  expect(res.status(), `Close failed: ${body.message}`).toBe(200);
  return body.data;
}

async function placeBid(request, token, lotId, maxBidCents) {
  return request.post(`/api/lots/${lotId}/bids`, {
    data:    { max_bid_cents: maxBidCents },
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── State shared across tests in this suite ───────────────────────────────────
let sellerToken, adminToken, buyerToken;
let sellerProfileId;
let auctionId, lot1Id, lot2Id;

// Cleanup: remove any auctions created by this suite
test.afterAll(async () => {
  if (auctionId) {
    await dbQuery('DELETE FROM bids              WHERE lot_id  IN (SELECT id FROM lots WHERE auction_id = $1)', [auctionId]);
    await dbQuery('DELETE FROM lot_proxy_bids    WHERE lot_id  IN (SELECT id FROM lots WHERE auction_id = $1)', [auctionId]);
    await dbQuery('DELETE FROM payments          WHERE lot_id  IN (SELECT id FROM lots WHERE auction_id = $1)', [auctionId]);
    await dbQuery('DELETE FROM seller_payouts    WHERE auction_id = $1', [auctionId]);
    await dbQuery('DELETE FROM lots              WHERE auction_id = $1', [auctionId]);
    await dbQuery('DELETE FROM auctions          WHERE id = $1',         [auctionId]);
  }
  if (_pool) await _pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Authentication
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 1 — Authentication', () => {
  test('seller, admin, buyer can log in', async ({ request }) => {
    [sellerToken, adminToken, buyerToken] = await Promise.all([
      login(request, SELLER),
      login(request, ADMIN),
      login(request, BUYER),
    ]);
    expect(sellerToken).toBeTruthy();
    expect(adminToken).toBeTruthy();
    expect(buyerToken).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Seller Profile
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 2 — Seller Profile', () => {
  test('GET /api/sellers/me returns seller profile', async ({ request }) => {
    const profile = await getSellerProfile(request, sellerToken);
    expect(profile.id, 'seller profile id missing').toBeTruthy();
    expect(profile.user_id, 'user_id missing').toBeTruthy();
    sellerProfileId = profile.id;
  });

  test('unauthenticated request returns 401', async ({ request }) => {
    const res = await request.get('/api/sellers/me');
    expect(res.status()).toBe(401);
  });

  test('wrong seller profile ID is rejected (403)', async ({ request }) => {
    const res = await request.post('/api/auctions', {
      data:    { sellerProfileId: '00000000-0000-0000-0000-000000000000', title: 'Sneaky Auction', state: 'draft' },
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Auction Creation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 3 — Auction Creation', () => {
  test('seller creates a draft auction', async ({ request }) => {
    const auction = await createAuction(request, sellerToken, {
      sellerProfileId,
      title:       `Self-Serve Rehearsal ${Date.now()}`,
      description: 'Test auction for self-serve flow',
      state:       'draft',
    });
    expect(auction.id).toBeTruthy();
    expect(auction.state).toBe('draft');
    expect(auction.seller_id).toBe(sellerProfileId);
    auctionId = auction.id;
  });

  test('missing title returns 400', async ({ request }) => {
    const res = await request.post('/api/auctions', {
      data:    { sellerProfileId },
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/title/i);
  });

  test('missing sellerProfileId returns 400', async ({ request }) => {
    const res = await request.post('/api/auctions', {
      data:    { title: 'No profile' },
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(400);
  });

  test('unauthenticated create returns 401', async ({ request }) => {
    const res = await request.post('/api/auctions', {
      data: { sellerProfileId, title: 'Anon Auction', state: 'draft' },
    });
    expect(res.status()).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — Lot Creation
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 4 — Lot Creation', () => {
  test('seller adds first lot to auction', async ({ request }) => {
    const lot = await createLot(request, sellerToken, auctionId, {
      title:          'Antique Oak Chair',
      description:    'Solid oak, ca. 1910',
      starting_price: 5.00,
    });
    expect(lot.id).toBeTruthy();
    expect(lot.state).toBe('open');
    expect(lot.starting_bid_cents).toBe(500);
    expect(lot.auction_id).toBe(auctionId);
    lot1Id = lot.id;
  });

  test('seller adds second lot to auction', async ({ request }) => {
    const lot = await createLot(request, sellerToken, auctionId, {
      title:          'Victorian Mirror',
      description:    'Gilded frame, 36 inches',
      starting_price: 10.00,
    });
    expect(lot.id).toBeTruthy();
    expect(lot.starting_bid_cents).toBe(1000);
    lot2Id = lot.id;
  });

  test('lot is visible in DB with correct columns', async () => {
    const rows = await dbQuery('SELECT * FROM lots WHERE id = $1', [lot1Id]);
    expect(rows[0]).toBeTruthy();
    expect(rows[0].starting_bid_cents).toBe(500);
    expect(rows[0].state).toBe('open');
    expect(rows[0].auction_id).toBe(auctionId);
  });

  test('non-owned auction returns 403', async ({ request }) => {
    // Valid UUID format but this auction doesn't belong to this seller
    const nonOwnedId = 'a0000000-0000-4000-8000-000000000001';
    const res = await request.post(`/api/auctions/${nonOwnedId}/lots`, {
      data:    { title: 'Sneaky Lot' },
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(403);
  });

  test('buyer cannot add lots to seller auction', async ({ request }) => {
    const res = await request.post(`/api/auctions/${auctionId}/lots`, {
      data:    { title: 'Buyer Lot Attempt' },
      headers: { Authorization: `Bearer ${buyerToken}` },
    });
    expect(res.status()).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Seller Dashboard (GET /api/auctions/my)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 5 — Seller Dashboard', () => {
  test('GET /api/auctions/my returns the created auction', async ({ request }) => {
    const res  = await request.get('/api/auctions/my', {
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const match = body.data.find(a => a.id === auctionId);
    expect(match, 'Created auction not found in /my list').toBeTruthy();
    expect(match.state).toBe('draft');
  });

  test('GET /api/auctions/:id returns the auction for its owner', async ({ request }) => {
    const res  = await request.get(`/api/auctions/${auctionId}`, {
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(auctionId);
  });

  test('buyer cannot fetch seller auction via /api/auctions/:id', async ({ request }) => {
    const res = await request.get(`/api/auctions/${auctionId}`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    });
    expect(res.status()).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — Admin Publish
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 6 — Admin Publish', () => {
  test('admin publishes the auction', async ({ request }) => {
    const auction = await adminPublish(request, adminToken, auctionId);
    expect(auction.state).toBe('published');
    expect(auction.start_time).toBeTruthy();
    expect(auction.end_time).toBeTruthy();
  });

  test('auction state is published in DB', async () => {
    const rows = await dbQuery('SELECT state FROM auctions WHERE id = $1', [auctionId]);
    expect(rows[0].state).toBe('published');
  });

  test('second publish attempt returns 409', async ({ request }) => {
    const res = await request.patch(`/api/admin/auctions/${auctionId}/publish`, {
      data:    {},
      headers: {
        Authorization:     `Bearer ${adminToken}`,
        'Idempotency-Key': `dup-publish-${auctionId}-${Date.now()}`,
      },
    });
    expect(res.status()).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — Buyer Bidding on Self-Serve Lots
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 7 — Buyer Bidding on Self-Serve Lots', () => {
  test('buyer can bid on lot 1', async ({ request }) => {
    const res  = await placeBid(request, buyerToken, lot1Id, 1000);
    expect(res.status(), 'Bid rejected').toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.visible_cents).toBeGreaterThanOrEqual(500);
  });

  test('bid is recorded in DB with correct columns', async () => {
    const rows = await dbQuery(
      'SELECT bidder_user_id, amount_cents FROM bids WHERE lot_id = $1 ORDER BY created_at DESC LIMIT 1',
      [lot1Id]
    );
    expect(rows[0]).toBeTruthy();
    expect(rows[0].amount_cents).toBeGreaterThan(0);
  });

  test('lot current_winner_user_id and bid_count are updated', async () => {
    const rows = await dbQuery('SELECT current_winner_user_id, bid_count FROM lots WHERE id = $1', [lot1Id]);
    expect(rows[0].current_winner_user_id).toBeTruthy();
    expect(rows[0].bid_count).toBeGreaterThan(0);
  });

  test('bid below minimum is rejected', async ({ request }) => {
    const lot  = (await dbQuery('SELECT current_bid_cents FROM lots WHERE id = $1', [lot1Id]))[0];
    const tooLow = lot.current_bid_cents; // exactly at current, not above
    const res = await placeBid(request, buyerToken, lot1Id, tooLow);
    expect(res.status()).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — Admin Close + Winner Assignment
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 8 — Admin Close + Winner Assignment', () => {
  test('admin closes the auction', async ({ request }) => {
    const result = await adminClose(request, adminToken, auctionId);
    expect(result.lots_closed).toBeGreaterThanOrEqual(1);
  });

  test('auction state is closed in DB', async () => {
    const rows = await dbQuery('SELECT state FROM auctions WHERE id = $1', [auctionId]);
    expect(rows[0].state).toBe('closed');
  });

  test('lot 1 has a winner assigned', async () => {
    const rows = await dbQuery(
      'SELECT state, winning_buyer_user_id, winning_amount_cents FROM lots WHERE id = $1',
      [lot1Id]
    );
    expect(rows[0].state).toBe('closed');
    expect(rows[0].winning_buyer_user_id).toBeTruthy();
    expect(rows[0].winning_amount_cents).toBeGreaterThan(0);
  });

  test('lot 2 (no bids) is closed without a winner', async () => {
    const rows = await dbQuery('SELECT state, winning_buyer_user_id FROM lots WHERE id = $1', [lot2Id]);
    expect(rows[0].state).toBe('closed');
    expect(rows[0].winning_buyer_user_id).toBeNull();
  });

  test('seller payout record was created', async () => {
    const rows = await dbQuery('SELECT * FROM seller_payouts WHERE auction_id = $1', [auctionId]);
    expect(rows[0]).toBeTruthy();
    expect(rows[0].gross_revenue_cents).toBeGreaterThan(0);
    expect(rows[0].platform_fee_cents).toBeGreaterThan(0);
    expect(rows[0].seller_payout_cents).toBeGreaterThan(0);
  });

  test('second close attempt returns 409', async ({ request }) => {
    const res = await request.post(`/api/admin/auctions/${auctionId}/close`, {
      data:    {},
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(409);
  });
});
