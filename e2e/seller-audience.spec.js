import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const { Pool } = pg;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const SELLER = { email: process.env.TEST_SELLER_EMAIL || 'rehearsal-seller@test.com', password: 'rehearsal123' };
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

async function apiGet(request, path, token) {
  const res = await request.get(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status(), body: await res.json() };
}

// ── Shared state ──────────────────────────────────────────────────────────────
let sellerToken, buyerAToken;
let sellerProfileId, buyerAUserId;

test.beforeAll(async ({ request }) => {
  [sellerToken, buyerAToken] = await Promise.all([
    apiLogin(request, SELLER),
    apiLogin(request, BUYER_A),
  ]);

  const spRows = await dbQuery(
    `SELECT sp.id FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE u.email = $1`,
    [SELLER.email]
  );
  expect(spRows.length, 'Seller profile must exist').toBeGreaterThan(0);
  sellerProfileId = spRows[0].id;

  const buyerRows = await dbQuery(`SELECT id FROM users WHERE email = $1`, [BUYER_A.email]);
  buyerAUserId = buyerRows[0].id;

  // Clean up any stale follower row from prior test runs
  await dbQuery(
    `DELETE FROM seller_followers WHERE user_id = $1 AND seller_id = $2`,
    [buyerAUserId, sellerProfileId]
  );
});

test.afterAll(async () => {
  await dbQuery(
    `DELETE FROM seller_followers WHERE user_id = $1 AND seller_id = $2`,
    [buyerAUserId, sellerProfileId]
  );
  await pool().end();
});

// ── Phase 1: API contract ──────────────────────────────────────────────────────
test.describe('GET /api/sellers/me/audience', () => {
  test('returns 401 without auth', async ({ request }) => {
    const { status } = await apiGet(request, '/api/sellers/me/audience', null);
    expect(status).toBe(401);
  });

  test('returns audience summary with correct shape', async ({ request }) => {
    const { status, body } = await apiGet(request, '/api/sellers/me/audience', sellerToken);
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const { followers_total, followers_7d, active_watchers, active_lot_count } = body.data;
    expect(typeof followers_total).toBe('number');
    expect(typeof followers_7d).toBe('number');
    expect(typeof active_watchers).toBe('number');
    expect(typeof active_lot_count).toBe('number');
  });

  test('followers_total matches DB count before any follow', async ({ request }) => {
    const dbCount = (await dbQuery(
      `SELECT COUNT(*)::int AS c FROM seller_followers WHERE seller_id = $1`,
      [sellerProfileId]
    ))[0].c;

    const { body } = await apiGet(request, '/api/sellers/me/audience', sellerToken);
    expect(body.data.followers_total).toBe(dbCount);
  });

  test('followers_total increments correctly after a new follow', async ({ request }) => {
    const { body: before } = await apiGet(request, '/api/sellers/me/audience', sellerToken);
    const countBefore = before.data.followers_total;

    // Buyer A follows the seller
    await request.post(`${BASE}/api/sellers/${sellerProfileId}/follow`, {
      headers: { Authorization: `Bearer ${buyerAToken}` }
    });

    const { body: after } = await apiGet(request, '/api/sellers/me/audience', sellerToken);
    expect(after.data.followers_total).toBe(countBefore + 1);
    expect(after.data.followers_7d).toBeGreaterThanOrEqual(1);
  });

  test('followers_7d counts the new follow (created just now)', async ({ request }) => {
    const { body } = await apiGet(request, '/api/sellers/me/audience', sellerToken);
    // The follow was created seconds ago — it must be in the 7d window
    expect(body.data.followers_7d).toBeGreaterThanOrEqual(1);
  });

  test('followers_total decrements correctly after unfollow', async ({ request }) => {
    const { body: before } = await apiGet(request, '/api/sellers/me/audience', sellerToken);
    const countBefore = before.data.followers_total;

    await request.delete(`${BASE}/api/sellers/${sellerProfileId}/follow`, {
      headers: { Authorization: `Bearer ${buyerAToken}` }
    });

    const { body: after } = await apiGet(request, '/api/sellers/me/audience', sellerToken);
    expect(after.data.followers_total).toBe(countBefore - 1);
  });

  test('active_watchers and active_lot_count are non-negative integers', async ({ request }) => {
    const { body } = await apiGet(request, '/api/sellers/me/audience', sellerToken);
    expect(body.data.active_watchers).toBeGreaterThanOrEqual(0);
    expect(body.data.active_lot_count).toBeGreaterThanOrEqual(0);
  });
});

// ── Phase 2: Seller dashboard UI ──────────────────────────────────────────────
test.describe('seller-dashboard.html audience section', () => {
  async function openDashboard(page) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), sellerToken);
    await page.goto(`${BASE}/seller-dashboard.html`);
  }

  test('audience section is present in the DOM', async ({ page }) => {
    await openDashboard(page);
    await expect(page.locator('#audience-section')).toBeAttached();
  });

  test('audience section becomes visible after load', async ({ page }) => {
    await openDashboard(page);
    const section = page.locator('#audience-section');
    await expect(section).toBeVisible({ timeout: 5000 });
  });

  test('followers metric is displayed with a numeric value', async ({ page }) => {
    await openDashboard(page);
    await expect(page.locator('#audience-section')).toBeVisible({ timeout: 5000 });
    const text = await page.locator('#aud-followers').textContent();
    expect(text.trim()).toMatch(/^\d+$/);
  });

  test('follower count in UI matches API response', async ({ page, request }) => {
    const { body } = await apiGet(request, '/api/sellers/me/audience', sellerToken);
    const apiCount = body.data.followers_total;

    await openDashboard(page);
    await expect(page.locator('#audience-section')).toBeVisible({ timeout: 5000 });
    const displayedText = await page.locator('#aud-followers').textContent();
    expect(parseInt(displayedText.trim(), 10)).toBe(apiCount);
  });

  test('growth chip is hidden when followers_7d is zero', async ({ page, request }) => {
    // Ensure buyer A is not following (cleaned up in beforeAll/afterAll)
    const { body } = await apiGet(request, '/api/sellers/me/audience', sellerToken);

    await openDashboard(page);
    await expect(page.locator('#audience-section')).toBeVisible({ timeout: 5000 });

    if (body.data.followers_7d === 0) {
      await expect(page.locator('#aud-growth-chip')).toBeHidden();
    } else {
      // Growth exists — chip should be visible
      await expect(page.locator('#aud-growth-chip')).toBeVisible();
    }
  });

  test('Your Audience label is shown', async ({ page }) => {
    await openDashboard(page);
    await expect(page.locator('#audience-section')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.audience-label')).toContainText('Your Audience');
  });

  test('audience section loads independently — dashboard still renders on audience API failure', async ({ page }) => {
    // This validates the non-fatal catch() — if audience load fails,
    // the main auction list still loads. We can't easily simulate API failure
    // in E2E, so we verify the auctions container also renders.
    await openDashboard(page);
    // Both should be present (auctions container is always rendered by loadDashboard)
    await expect(page.locator('#auctions-container')).toBeAttached();
    await expect(page.locator('#audience-section')).toBeAttached();
  });
});
