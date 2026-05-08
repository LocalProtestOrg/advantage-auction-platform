import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const { Pool } = pg;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const SELLER = {
  email:    process.env.TEST_SELLER_EMAIL    || 'rehearsal-seller@test.com',
  password: process.env.TEST_SELLER_PASSWORD || 'rehearsal123',
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

// ── API helpers (used in setup) ───────────────────────────────────────────────
async function apiLogin(request, creds) {
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}`).toBe(200);
  return body.token;
}

async function apiPost(request, token, path, data) {
  const res  = await request.post(path, {
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return { status: res.status(), body };
}

// ── Browser auth helper ────────────────────────────────────────────────────────
// Sets the JWT in localStorage so the dashboard page accepts the session.
async function openDashboardAs(page, token) {
  // Navigate to a blank page first so we can set localStorage on the right origin
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), token);
  await page.goto(`${BASE}/seller-dashboard.html`);
}

// ── Shared state ──────────────────────────────────────────────────────────────
let sellerToken, sellerProfileId;
let auctionId, lot1Id;

test.afterAll(async () => {
  if (auctionId) {
    await dbQuery('DELETE FROM bids            WHERE lot_id  IN (SELECT id FROM lots WHERE auction_id = $1)', [auctionId]);
    await dbQuery('DELETE FROM lot_proxy_bids  WHERE lot_id  IN (SELECT id FROM lots WHERE auction_id = $1)', [auctionId]);
    await dbQuery('DELETE FROM lots            WHERE auction_id = $1', [auctionId]);
    await dbQuery('DELETE FROM auctions        WHERE id = $1', [auctionId]);
  }
  if (_pool) await _pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Setup: create a draft auction + one lot for dashboard tests
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 1 — Setup', () => {
  test('login and get seller profile', async ({ request }) => {
    sellerToken = await apiLogin(request, SELLER);
    const res  = await request.get('/api/sellers/me', { headers: { Authorization: `Bearer ${sellerToken}` } });
    const body = await res.json();
    sellerProfileId = body.data.id;
    expect(sellerProfileId).toBeTruthy();
  });

  test('create a draft auction', async ({ request }) => {
    const { status, body } = await apiPost(request, sellerToken, '/api/auctions', {
      sellerProfileId,
      title: `Dashboard Test Auction ${Date.now()}`,
      state: 'draft',
    });
    expect(status).toBe(201);
    auctionId = body.data.id;
    expect(auctionId).toBeTruthy();
  });

  test('add an initial lot', async ({ request }) => {
    const { status, body } = await apiPost(request, sellerToken, '/api/lots', {
      auctionId,
      title:              'Victorian Mirror',
      description:        'Gilded frame, 36 inches',
      starting_bid_cents: 1000,
    });
    expect(status, `Create lot failed: ${body.message}`).toBe(201);
    lot1Id = body.data.id;
    expect(lot1Id).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Page Load
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 2 — Page Load', () => {
  test('unauthenticated user is redirected to /login.html', async ({ page }) => {
    // Clear any existing token
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.removeItem('token'));
    await page.goto(`${BASE}/seller-dashboard.html`);
    await expect(page).toHaveURL(/login\.html/);
  });

  test('dashboard loads without console errors', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', err => errors.push(err.message));

    await openDashboardAs(page, sellerToken);

    // Wait for auctions to load (spinner disappears, auction card appears)
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    // Filter out network errors for non-critical endpoints
    const jsErrors = errors.filter(e => !e.includes('favicon') && !e.includes('net::'));
    expect(jsErrors, `Console errors: ${jsErrors.join('; ')}`).toHaveLength(0);
  });

  test('page title is correct', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await expect(page).toHaveTitle(/My Auctions/);
  });

  test('brand and logout button are present', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await expect(page.locator('header .brand')).toHaveText('Advantage Auction');
    await expect(page.locator('#btn-logout')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Auction List
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 3 — Auction List', () => {
  test('created auction appears in list', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    const card = page.locator(`.auction-card[data-auction-id="${auctionId}"]`);
    await expect(card).toBeVisible();
  });

  test('auction shows draft state badge', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    const card = page.locator(`.auction-card[data-auction-id="${auctionId}"]`);
    await expect(card.locator('.badge-draft')).toBeVisible();
  });

  test('summary bar shows draft count ≥ 1', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('#summary-bar:not([style*="display: none"])', { timeout: 10_000 });

    const draftCount = parseInt(await page.locator('#sum-draft').textContent(), 10);
    expect(draftCount).toBeGreaterThanOrEqual(1);
  });

  test('"+ New Auction" link points to seller-create.html', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    const link = page.locator('header a[href="/seller-create.html"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('+ New Auction');
  });

  test('"+ Add Lot" button is present for draft auction', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    const addBtn = page.locator(`.auction-card[data-auction-id="${auctionId}"] [data-add-lot="${auctionId}"]`);
    await expect(addBtn).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — View Lots
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 4 — View Lots', () => {
  test('clicking "View Lots" opens lot panel and loads lots', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    // Click toggle button
    await page.locator(`.auction-card[data-auction-id="${auctionId}"] [data-toggle-lots="${auctionId}"]`).click();

    // Lots panel becomes visible
    const panel = page.locator(`#lots-${auctionId}`);
    await expect(panel).toBeVisible();

    // Wait for lot row to load (replaces "Click 'View Lots' to load")
    await page.waitForSelector(`#lots-list-${auctionId} .lot-row`, { timeout: 8_000 });

    // Initial lot "Victorian Mirror" is present
    const row = page.locator(`#lot-row-${lot1Id}`);
    await expect(row).toBeVisible();
    await expect(row.locator('.lot-title')).toContainText('Victorian Mirror');
  });

  test('lot count badge shows correct number', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });
    await page.locator(`[data-toggle-lots="${auctionId}"]`).click();
    await page.waitForSelector(`#lots-list-${auctionId} .lot-row`, { timeout: 8_000 });

    const countEl = page.locator(`#lot-count-${auctionId}`);
    await expect(countEl).toContainText('lot');
  });

  test('clicking "View Lots" again collapses panel', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    const toggleBtn = page.locator(`[data-toggle-lots="${auctionId}"]`);
    await toggleBtn.click();
    await page.waitForSelector(`#lots-list-${auctionId} .lot-row`, { timeout: 8_000 });
    await toggleBtn.click();

    const panel = page.locator(`#lots-${auctionId}`);
    await expect(panel).not.toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Add Lot
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 5 — Add Lot', () => {
  test('add lot form opens when "+ Add Lot" is clicked', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    await page.locator(`[data-add-lot="${auctionId}"]`).click();
    await expect(page.locator('[data-form="add"]')).toBeVisible();
  });

  test('submitting add lot form creates a new lot', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    // Open lots panel first so we can see the result
    await page.locator(`[data-toggle-lots="${auctionId}"]`).click();
    await page.waitForSelector(`#lots-list-${auctionId} .lot-row`, { timeout: 8_000 });

    // Open add form
    await page.locator(`[data-add-lot="${auctionId}"]`).click();
    await expect(page.locator('[data-form="add"]')).toBeVisible();

    // Fill form
    await page.locator('[data-form="add"] input[name="title"]').fill('Antique Brass Lamp');
    await page.locator('[data-form="add"] textarea[name="description"]').fill('Works, original shade');
    await page.locator('[data-form="add"] select[name="size_category"]').selectOption('A');
    await page.locator('[data-form="add"] input[name="starting_bid"]').fill('3.00');

    // Submit
    await page.locator('[data-action="submit-add"]').click();

    // Success banner appears
    await expect(page.locator('#status-banner.success')).toBeVisible({ timeout: 6_000 });

    // Form closes
    await expect(page.locator('[data-form="add"]')).not.toBeVisible();

    // New lot appears in the list (DOM interleaves .lot-row and edit-holder divs, so count by class)
    await expect(page.locator(`#lots-list-${auctionId} .lot-row`)).toHaveCount(2, { timeout: 8_000 });
    const titles = await page.locator(`#lots-list-${auctionId} .lot-title`).allTextContents();
    expect(titles).toContain('Antique Brass Lamp');
  });

  test('add lot with empty title shows error', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    await page.locator(`[data-add-lot="${auctionId}"]`).click();
    await expect(page.locator('[data-form="add"]')).toBeVisible();

    // Submit without title
    await page.locator('[data-action="submit-add"]').click();

    await expect(page.locator('#status-banner.error')).toBeVisible({ timeout: 4_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — Edit Lot
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 6 — Edit Lot', () => {
  test('edit form opens for a lot', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    await page.locator(`[data-toggle-lots="${auctionId}"]`).click();
    await page.waitForSelector(`#lot-row-${lot1Id}`, { timeout: 8_000 });

    await page.locator(`[data-edit-lot="${lot1Id}"]`).click();
    await expect(page.locator(`#edit-form-${lot1Id} [data-form="edit"]`)).toBeVisible();
  });

  test('edit form is pre-populated with existing values', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    await page.locator(`[data-toggle-lots="${auctionId}"]`).click();
    await page.waitForSelector(`#lot-row-${lot1Id}`, { timeout: 8_000 });

    await page.locator(`[data-edit-lot="${lot1Id}"]`).click();
    const titleField = page.locator(`#edit-form-${lot1Id} input[name="title"]`);
    await expect(titleField).toHaveValue('Victorian Mirror');
  });

  test('saving changes updates the lot', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    await page.locator(`[data-toggle-lots="${auctionId}"]`).click();
    await page.waitForSelector(`#lot-row-${lot1Id}`, { timeout: 8_000 });

    await page.locator(`[data-edit-lot="${lot1Id}"]`).click();

    // Change the title
    const titleField = page.locator(`#edit-form-${lot1Id} input[name="title"]`);
    await titleField.fill('Victorian Mirror (Updated)');

    await page.locator(`#edit-form-${lot1Id} [data-action="submit-edit"]`).click();

    await expect(page.locator('#status-banner.success')).toBeVisible({ timeout: 6_000 });

    // Lot list reloads — updated title appears
    await page.waitForFunction(
      id => document.querySelector(`#lot-row-${id} .lot-title`)?.textContent?.includes('Updated'),
      lot1Id,
      { timeout: 8_000 }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — Remove Lot
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 7 — Remove Lot', () => {
  test('remove button appears for lot with 0 bids', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    await page.locator(`[data-toggle-lots="${auctionId}"]`).click();
    await page.waitForSelector(`#lot-row-${lot1Id}`, { timeout: 8_000 });

    await expect(page.locator(`[data-remove-lot="${lot1Id}"]`)).toBeVisible();
  });

  test('confirming remove withdraws the lot', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    await page.locator(`[data-toggle-lots="${auctionId}"]`).click();
    await page.waitForSelector(`#lot-row-${lot1Id}`, { timeout: 8_000 });

    // Accept the browser confirm dialog
    page.once('dialog', dialog => dialog.accept());
    await page.locator(`[data-remove-lot="${lot1Id}"]`).click();

    await expect(page.locator('#status-banner.success')).toBeVisible({ timeout: 6_000 });

    // The lot row disappears after reload
    await page.waitForFunction(
      id => !document.getElementById(`lot-row-${id}`),
      lot1Id,
      { timeout: 8_000 }
    );
  });

  test('dismissed remove confirm leaves lot intact', async ({ page }) => {
    // Add a fresh lot so the phase has a valid target
    const loginRes = await page.request.post('/api/auth/login', { data: SELLER });
    const body = await loginRes.json();
    const tok = body.token;

    const createRes = await page.request.post('/api/lots', {
      data:    { auctionId, title: 'Keep Me', starting_bid_cents: 200 },
      headers: { Authorization: `Bearer ${tok}` },
    });
    const createBody = await createRes.json();
    const tmpLotId = createBody.data.id;

    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    await page.locator(`[data-toggle-lots="${auctionId}"]`).click();
    await page.waitForSelector(`#lot-row-${tmpLotId}`, { timeout: 8_000 });

    // Dismiss the confirm dialog
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator(`[data-remove-lot="${tmpLotId}"]`).click();

    // Row should still be present
    await expect(page.locator(`#lot-row-${tmpLotId}`)).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — Logout
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 8 — Logout', () => {
  test('clicking logout clears token and redirects to login', async ({ page }) => {
    await openDashboardAs(page, sellerToken);
    await page.waitForSelector('.auction-card', { timeout: 10_000 });

    await page.locator('#btn-logout').click();

    await expect(page).toHaveURL(/login\.html/, { timeout: 5_000 });

    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeNull();
  });
});
