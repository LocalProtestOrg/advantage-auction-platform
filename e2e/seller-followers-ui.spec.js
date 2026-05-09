import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const { Pool } = pg;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Use BUYER_C to avoid parallel-run contamination with seller-followers.spec.js
// which uses buyer-a and buyer-b for follow-state assertions.
const BUYER_C = { email: 'rehearsal-buyer-c@test.com', password: 'rehearsal123' };

// Auction that has a known seller_id from demo seed data.
const TEST_AUCTION_ID  = 'dd000000-0000-4000-8000-000000000010';
const TEST_SELLER_ID   = 'dd000000-0000-4000-8000-000000000003';

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

// ── Auth helper ────────────────────────────────────────────────────────────────
async function loginAs(request, creds) {
  const res  = await request.post(`${BASE}/api/auth/login`, { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}`).toBe(200);
  return body.token;
}

async function setToken(page, token) {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), token);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
test.beforeAll(async () => {
  // Clear any stale follow from prior runs.
  const buyerRows = await dbQuery(`SELECT id FROM users WHERE email = $1`, [BUYER_C.email]);
  if (buyerRows.length) {
    await dbQuery(
      `DELETE FROM seller_followers WHERE user_id = $1 AND seller_id = $2`,
      [buyerRows[0].id, TEST_SELLER_ID]
    );
  }
});

test.afterAll(async () => {
  const buyerRows = await dbQuery(`SELECT id FROM users WHERE email = $1`, [BUYER_C.email]);
  if (buyerRows.length) {
    await dbQuery(
      `DELETE FROM seller_followers WHERE user_id = $1 AND seller_id = $2`,
      [buyerRows[0].id, TEST_SELLER_ID]
    );
  }
  await pool().end();
});

// ── Phase 1: auction-view.html seller bar ─────────────────────────────────────
test.describe('auction-view.html — seller bar', () => {
  test('summary endpoint returns seller_id and follower_count', async ({ request }) => {
    const res  = await request.get(`${BASE}/api/auctions/${TEST_AUCTION_ID}/summary`);
    const body = await res.json();
    expect(res.status()).toBe(200);
    expect(body.data.seller_id).toBe(TEST_SELLER_ID);
    expect(typeof body.data.follower_count).toBe('number');
    expect(body.data.title).toBeTruthy();
  });

  test('seller bar is visible on auction-view page (unauthenticated)', async ({ page }) => {
    await page.goto(`${BASE}/auction-view.html?auctionId=${TEST_AUCTION_ID}`);
    // Wait for seller info to load.
    const bar = page.locator('#seller-bar');
    await expect(bar).toBeVisible({ timeout: 5000 });
    // Follower count text should be present.
    await expect(page.locator('#follower-count-display')).toBeVisible();
    // No Follow button for unauthenticated users.
    await expect(page.locator('.btn-follow')).toHaveCount(0);
  });

  test('auction title is populated from summary (not "Auction" placeholder)', async ({ page }) => {
    await page.goto(`${BASE}/auction-view.html?auctionId=${TEST_AUCTION_ID}`);
    await page.waitForFunction(
      () => document.getElementById('auction-title')?.textContent !== 'Loading auction…' &&
            document.getElementById('auction-title')?.textContent !== 'Auction',
      { timeout: 5000 }
    );
    const title = await page.locator('#auction-title').textContent();
    expect(title.trim().length).toBeGreaterThan(0);
    expect(title).not.toBe('Auction');
    expect(title).not.toBe('Loading auction…');
  });

  test('Follow button appears when buyer is authenticated', async ({ page, request }) => {
    const token = await loginAs(request, BUYER_C);
    await setToken(page, token);
    await page.goto(`${BASE}/auction-view.html?auctionId=${TEST_AUCTION_ID}`);

    const btn = page.locator('.btn-follow');
    await expect(btn).toBeVisible({ timeout: 5000 });
    await expect(btn).toHaveText('Follow Seller');
  });

  test('clicking Follow changes button to Following and updates count', async ({ page, request }) => {
    const token = await loginAs(request, BUYER_C);
    await setToken(page, token);
    await page.goto(`${BASE}/auction-view.html?auctionId=${TEST_AUCTION_ID}`);

    const btn       = page.locator('.btn-follow');
    const countEl   = page.locator('#follower-count-display');

    await expect(btn).toBeVisible({ timeout: 5000 });
    const countBefore = await countEl.textContent();

    await btn.click();

    // Optimistic update: button should flip immediately.
    await expect(btn).toHaveText('Following', { timeout: 3000 });
    await expect(btn).toHaveClass(/following/);

    // Count should have incremented.
    const countAfter = await countEl.textContent();
    expect(countAfter).not.toBe(countBefore);
  });

  test('refreshing page shows Following state (persisted)', async ({ page, request }) => {
    const token = await loginAs(request, BUYER_C);
    await setToken(page, token);
    await page.goto(`${BASE}/auction-view.html?auctionId=${TEST_AUCTION_ID}`);

    const btn = page.locator('.btn-follow');
    await expect(btn).toBeVisible({ timeout: 5000 });
    // Should already be Following from previous test (serial mode).
    await expect(btn).toHaveText('Following');
    await expect(btn).toHaveClass(/following/);
  });

  test('clicking Following unfollows and reverts button', async ({ page, request }) => {
    const token = await loginAs(request, BUYER_C);
    await setToken(page, token);
    await page.goto(`${BASE}/auction-view.html?auctionId=${TEST_AUCTION_ID}`);

    const btn = page.locator('.btn-follow');
    await expect(btn).toHaveText('Following', { timeout: 5000 });

    await btn.click();

    await expect(btn).toHaveText('Follow Seller', { timeout: 3000 });
    await expect(btn).not.toHaveClass(/following/);
  });
});

// ── Phase 2: dashboard.html Following Sellers section ─────────────────────────
test.describe('dashboard.html — Following Sellers section', () => {
  test('Following Sellers section is present in the DOM', async ({ page, request }) => {
    const token = await loginAs(request, BUYER_C);
    await setToken(page, token);
    await page.goto(`${BASE}/dashboard.html`);

    await expect(page.locator('.section-title')).toContainText('Following Sellers');
    await expect(page.locator('#following-list')).toBeVisible();
  });

  test('empty state shown when not following anyone', async ({ page, request }) => {
    const token = await loginAs(request, BUYER_C);
    await setToken(page, token);
    await page.goto(`${BASE}/dashboard.html`);

    const empty = page.locator('#following-list .empty');
    await expect(empty).toBeVisible({ timeout: 4000 });
    await expect(empty).toContainText('not following any sellers');
  });

  test('after following a seller, seller row appears in dashboard', async ({ page, request }) => {
    const token = await loginAs(request, BUYER_C);
    await setToken(page, token);

    // Follow via API first.
    await request.post(`${BASE}/api/sellers/${TEST_SELLER_ID}/follow`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    await page.goto(`${BASE}/dashboard.html`);

    const row = page.locator('.seller-row');
    await expect(row).toBeVisible({ timeout: 4000 });
    await expect(page.locator('.seller-row-name')).toBeVisible();
    await expect(page.locator('.seller-row-meta')).toBeVisible();
    await expect(page.locator('.btn-unfollow')).toBeVisible();
  });

  test('clicking Unfollow removes the row from the dashboard', async ({ page, request }) => {
    const token = await loginAs(request, BUYER_C);
    await setToken(page, token);
    await page.goto(`${BASE}/dashboard.html`);

    const row     = page.locator('.seller-row');
    const unfollowBtn = page.locator('.btn-unfollow');
    await expect(unfollowBtn).toBeVisible({ timeout: 4000 });

    await unfollowBtn.click();

    // Row fades out then is removed.
    await expect(row).toHaveCount(0, { timeout: 3000 });

    // Empty state should appear.
    const empty = page.locator('#following-list .empty');
    await expect(empty).toBeVisible({ timeout: 3000 });
  });
});
