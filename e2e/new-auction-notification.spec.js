import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const { Pool } = pg;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const ADMIN   = { email: process.env.TEST_ADMIN_EMAIL  || 'test-admin@example.com', password: process.env.TEST_ADMIN_PASSWORD || 'rehearsal123' };
const SELLER  = { email: process.env.TEST_SELLER_EMAIL || 'rehearsal-seller@test.com', password: 'rehearsal123' };
const BUYER_A = { email: 'rehearsal-buyer-a@test.com', password: 'rehearsal123' };
const BUYER_B = { email: 'rehearsal-buyer-b@test.com', password: 'rehearsal123' };

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
let adminToken, buyerAToken, buyerBToken;
let sellerProfileId, buyerAUserId, buyerBUserId;
const createdAuctionIds = [];

// Creates a draft auction and tracks it for cleanup.
async function createDraftAuction(title) {
  const rows = await dbQuery(
    `INSERT INTO auctions (seller_id, title, state, created_at, updated_at)
     VALUES ($1, $2, 'draft', NOW(), NOW())
     RETURNING id`,
    [sellerProfileId, title]
  );
  const id = rows[0].id;
  createdAuctionIds.push(id);
  return id;
}

test.beforeAll(async ({ request }) => {
  [adminToken, buyerAToken, buyerBToken] = await Promise.all([
    apiLogin(request, ADMIN),
    apiLogin(request, BUYER_A),
    apiLogin(request, BUYER_B),
  ]);

  const [spRows, aRows, bRows] = await Promise.all([
    dbQuery(
      `SELECT sp.id FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE u.email = $1`,
      [SELLER.email]
    ),
    dbQuery(`SELECT id FROM users WHERE email = $1`, [BUYER_A.email]),
    dbQuery(`SELECT id FROM users WHERE email = $1`, [BUYER_B.email]),
  ]);

  expect(spRows.length, 'Seller profile must exist').toBeGreaterThan(0);
  sellerProfileId = spRows[0].id;
  buyerAUserId    = aRows[0].id;
  buyerBUserId    = bRows[0].id;

  // Clean up any stale state from prior runs of this spec.
  await dbQuery(
    `DELETE FROM seller_followers WHERE seller_id = $1 AND user_id IN ($2, $3)`,
    [sellerProfileId, buyerAUserId, buyerBUserId]
  );
});

test.afterAll(async () => {
  for (const aId of createdAuctionIds) {
    await dbQuery(`DELETE FROM notifications_queue WHERE payload->>'auction_id' = $1`, [aId]);
    await dbQuery(`DELETE FROM lots    WHERE auction_id = $1`, [aId]);
    await dbQuery(`DELETE FROM auctions WHERE id        = $1`, [aId]);
  }
  await dbQuery(
    `DELETE FROM seller_followers WHERE seller_id = $1 AND user_id IN ($2, $3)`,
    [sellerProfileId, buyerAUserId, buyerBUserId]
  );
  // Remove test preference overrides (these are rehearsal accounts — safe to delete).
  await dbQuery(
    `DELETE FROM notification_preferences WHERE user_id IN ($1, $2)`,
    [buyerAUserId, buyerBUserId]
  );
  await pool().end();
});

// ── Group 1: Payload completeness ─────────────────────────────────────────────
// Verifies every field the worker depends on is present and typed correctly.
test.describe('Notification payload completeness', () => {
  let auctionId;

  test('setup: buyer A follows seller', async ({ request }) => {
    const { status } = await api(request, 'post', `/api/sellers/${sellerProfileId}/follow`, buyerAToken);
    expect(status).toBe(200);
  });

  test('setup: create draft auction', async () => {
    auctionId = await createDraftAuction('Payload Completeness Test Auction');
  });

  test('NEW_AUCTION payload contains all required fields with correct types', async ({ request }) => {
    const { status, body } = await api(
      request, 'patch', `/api/admin/auctions/${auctionId}/publish`, adminToken
    );
    expect(status, JSON.stringify(body)).toBe(200);

    // Allow async fan-out after response.
    await new Promise(r => setTimeout(r, 300));

    const rows = await dbQuery(
      `SELECT payload FROM notifications_queue
        WHERE type = 'NEW_AUCTION'
          AND user_id = $1
          AND payload->>'auction_id' = $2`,
      [buyerAUserId, auctionId]
    );
    expect(rows.length).toBe(1);

    const p = rows[0].payload;
    expect(p.auction_id).toBe(auctionId);
    expect(p.seller_id).toBe(sellerProfileId);
    expect(typeof p.title).toBe('string');
    expect(p.title.length).toBeGreaterThan(0);
    expect(typeof p.lot_count).toBe('number');
    expect(p.lot_count).toBeGreaterThanOrEqual(0);
    expect(p.auction_url).toMatch(/auction-view\.html\?auctionId=/);
  });

  test('notification row has status=pending and attempts=0', async () => {
    const rows = await dbQuery(
      `SELECT status, attempts FROM notifications_queue
        WHERE type = 'NEW_AUCTION'
          AND user_id = $1
          AND payload->>'auction_id' = $2`,
      [buyerAUserId, auctionId]
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBe(0);
  });
});

// ── Group 2: Email preference exclusion ───────────────────────────────────────
// Verifies that the follower query respects notification_preferences.email_enabled.
test.describe('Email preference exclusion', () => {
  let auctionId;

  test('setup: buyer B follows seller, then opts out of email', async ({ request }) => {
    await api(request, 'post', `/api/sellers/${sellerProfileId}/follow`, buyerBToken);

    // Opt buyer B out of email notifications.
    await dbQuery(
      `INSERT INTO notification_preferences (user_id, email_enabled, sms_enabled)
       VALUES ($1, false, false)
       ON CONFLICT (user_id) DO UPDATE SET email_enabled = false`,
      [buyerBUserId]
    );
  });

  test('setup: create draft auction', async () => {
    auctionId = await createDraftAuction('Email Exclusion Test Auction');
  });

  test('buyer with email_enabled=false is not queued on publish', async ({ request }) => {
    const { status, body } = await api(
      request, 'patch', `/api/admin/auctions/${auctionId}/publish`, adminToken
    );
    expect(status, JSON.stringify(body)).toBe(200);

    await new Promise(r => setTimeout(r, 300));

    const rows = await dbQuery(
      `SELECT id FROM notifications_queue
        WHERE type = 'NEW_AUCTION'
          AND user_id = $1
          AND payload->>'auction_id' = $2`,
      [buyerBUserId, auctionId]
    );
    expect(rows.length).toBe(0);
  });

  test('buyer A (default email_enabled=true) is still queued', async () => {
    const rows = await dbQuery(
      `SELECT id FROM notifications_queue
        WHERE type = 'NEW_AUCTION'
          AND user_id = $1
          AND payload->>'auction_id' = $2`,
      [buyerAUserId, auctionId]
    );
    expect(rows.length).toBe(1);
  });
});

// ── Group 3: NOT EXISTS idempotency guard ─────────────────────────────────────
// Verifies that the INSERT...SELECT with NOT EXISTS dedup guard, which is the
// exact SQL used by enqueueNewAuctionNotifications, produces exactly one row
// even when executed multiple times for the same (user, auction) pair.
test.describe('Idempotency — NOT EXISTS dedup guard', () => {
  let auctionId;

  test('setup: create draft auction', async () => {
    auctionId = await createDraftAuction('Idempotency Test Auction');
  });

  test('first publish enqueues exactly one notification for buyer A', async ({ request }) => {
    const { status, body } = await api(
      request, 'patch', `/api/admin/auctions/${auctionId}/publish`, adminToken
    );
    expect(status, JSON.stringify(body)).toBe(200);

    await new Promise(r => setTimeout(r, 300));

    const rows = await dbQuery(
      `SELECT id FROM notifications_queue
        WHERE type = 'NEW_AUCTION'
          AND user_id = $1
          AND payload->>'auction_id' = $2`,
      [buyerAUserId, auctionId]
    );
    expect(rows.length).toBe(1);
  });

  test('running the same INSERT…SELECT again does not create a duplicate', async () => {
    // Simulate enqueueNewAuctionNotifications being called a second time for
    // the same auction (e.g., crash-restart or accidental double-trigger).
    const dupPayload = JSON.stringify({
      auction_id:  auctionId,
      seller_id:   sellerProfileId,
      title:       'Idempotency Test Auction',
      lot_count:   0,
      auction_url: `/auction-view.html?auctionId=${auctionId}`,
    });
    await dbQuery(
      `INSERT INTO notifications_queue (user_id, type, payload)
       SELECT u, 'NEW_AUCTION', $2::jsonb
       FROM   unnest($1::uuid[]) AS u
       WHERE  NOT EXISTS (
         SELECT 1 FROM notifications_queue nq
         WHERE  nq.type                   = 'NEW_AUCTION'
           AND  nq.payload->>'auction_id' = $3
           AND  nq.user_id                = u
       )`,
      [[buyerAUserId], dupPayload, auctionId]
    );

    const rows = await dbQuery(
      `SELECT id FROM notifications_queue
        WHERE type = 'NEW_AUCTION'
          AND user_id = $1
          AND payload->>'auction_id' = $2`,
      [buyerAUserId, auctionId]
    );
    expect(rows.length).toBe(1);
  });
});

// ── Group 4: Fan-out is non-fatal ─────────────────────────────────────────────
// The auction publish response must succeed even when there are no followers
// (enqueueNewAuctionNotifications returns early, never throws).
test.describe('Fan-out is non-fatal', () => {
  test('setup: remove all followers', async () => {
    await dbQuery(
      `DELETE FROM seller_followers WHERE seller_id = $1`,
      [sellerProfileId]
    );
  });

  test('publish succeeds and returns published state when seller has no followers', async ({ request }) => {
    const auctionId = await createDraftAuction('No Followers Auction');

    const { status, body } = await api(
      request, 'patch', `/api/admin/auctions/${auctionId}/publish`, adminToken
    );
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.data.state).toBe('published');

    await new Promise(r => setTimeout(r, 200));

    const rows = await dbQuery(
      `SELECT id FROM notifications_queue
        WHERE type = 'NEW_AUCTION'
          AND payload->>'auction_id' = $1`,
      [auctionId]
    );
    expect(rows.length).toBe(0);
  });
});
