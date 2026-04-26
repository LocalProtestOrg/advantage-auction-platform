import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';
import crypto from 'crypto';

test.describe.configure({ mode: 'serial' });

const { Pool } = pg;

const AUCTION_ID  = '2eb81a2a-27aa-42fd-887b-bb343c48819d';
const ADMIN_EMAIL = 'tylerwitt2015@gmail.com';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;

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
  const token = body.data?.token;
  expect(token, 'JWT missing from login response').toBeTruthy();
  return token;
}

async function resetToDraft() {
  const pool = getPool();
  try {
    await pool.query("UPDATE auctions SET status = 'draft' WHERE id = $1", [AUCTION_ID]);
  } finally {
    await pool.end();
  }
}

// Look up the idempotency row for a specific key+route combination.
// Uses the same hash algorithm as src/middleware/idempotency.js.
function idempotencyHash(key, method, url, body = undefined) {
  return crypto.createHash('sha256')
    .update(key + method + url + JSON.stringify(body))
    .digest('hex');
}

async function getIdempotencyRow(hash, route) {
  const pool = getPool();
  try {
    const res = await pool.query(
      `SELECT response_status, response_body
       FROM payment_idempotency_keys
       WHERE idempotency_key = $1 AND route = $2`,
      [hash, route]
    );
    return res.rows;
  } finally {
    await pool.end();
  }
}

async function countAuditRows(eventType, auctionId, since) {
  const pool = getPool();
  try {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audit_log
       WHERE event_type = $1 AND auction_id = $2 AND created_at >= $3`,
      [eventType, auctionId, since]
    );
    return res.rows[0].count;
  } finally {
    await pool.end();
  }
}

// ─── Test: publish idempotency replay ───────────────────────────────────────
// Same key sent twice to publish must:
//   1. Return identical response on the second call (replayed from DB)
//   2. NOT re-execute business logic (only one audit_log row)
//   3. Store exactly one idempotency row in DB

test('admin publish - same idempotency key replays stored response without re-executing', async ({ request }) => {
  await resetToDraft();

  const token = await loginAs(request, ADMIN_EMAIL, ADMIN_PASS);
  const idemKey = `test-publish-idem-${Date.now()}`;
  const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': idemKey };
  const url = `/api/admin/auctions/${AUCTION_ID}/publish`;

  const testStartedAt = new Date();

  // First call — publishes the auction, stores idempotency row
  const res1 = await request.patch(url, { headers });
  expect(res1.status(), 'First publish should succeed').toBe(200);
  const body1 = await res1.json();

  // Verify idempotency row was written with a completed response.
  // Look up by exact hash so repeated test runs don't accumulate and corrupt the count.
  const hash = idempotencyHash(idemKey, 'PATCH', url);
  const rows = await getIdempotencyRow(hash, `PATCH ${url}`);
  expect(rows.length, 'Expected one idempotency row in DB').toBe(1);
  expect(rows[0].response_status, 'Stored status should be 200').toBe(200);
  expect(rows[0].response_body, 'Stored response_body should not be null').not.toBeNull();

  // Second call — same key, auction is now published
  // Without idempotency: would get "Auction is already published" error
  // With idempotency replay: must get the original 200 back
  const res2 = await request.patch(url, { headers });
  expect(res2.status(), 'Second call with same key should replay 200').toBe(200);
  const body2 = await res2.json();
  expect(body2, 'Replayed body must equal first response').toEqual(body1);

  // Business logic must not have re-run: exactly one audit_log row since test start
  const auditCount = await countAuditRows('auction.published', AUCTION_ID, testStartedAt);
  expect(auditCount, 'Should be exactly one auction.published audit row').toBe(1);
});

test.afterAll(async () => {
  await resetToDraft();
});
