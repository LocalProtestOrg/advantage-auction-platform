import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';

test.describe.configure({ mode: 'serial' });

const { Pool } = pg;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const SELLER = { email: 'rehearsal-seller@test.com', password: 'rehearsal123' };
const ADMIN  = { email: 'test-admin@example.com',    password: 'rehearsal123' };
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
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}: ${body.error}`).toBe(200);
  return body.token;
}

async function apiPost(request, token, path, data) {
  const res  = await request.post(path, {
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status(), body: await res.json() };
}

async function apiPatch(request, token, path, data) {
  const res = await request.patch(path, {
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status(), body: await res.json() };
}

// ── Browser helpers ───────────────────────────────────────────────────────────
async function openPageAs(page, token, path) {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), token);
  await page.goto(`${BASE}${path}`);
}

// ── Shared state ──────────────────────────────────────────────────────────────
let sellerToken, adminToken, buyerAToken, buyerBToken;
let sellerProfileId, buyerAUserId;
let auctionId, lotId;
let newBuyerEmail, newBuyerToken;

test.afterAll(async () => {
  if (auctionId) {
    await dbQuery('DELETE FROM bids           WHERE lot_id IN (SELECT id FROM lots WHERE auction_id = $1)', [auctionId]);
    await dbQuery('DELETE FROM lot_proxy_bids WHERE lot_id IN (SELECT id FROM lots WHERE auction_id = $1)', [auctionId]);
    await dbQuery('DELETE FROM payments       WHERE lot_id IN (SELECT id FROM lots WHERE auction_id = $1)', [auctionId]);
    await dbQuery('DELETE FROM invoices       WHERE lot_id IN (SELECT id FROM lots WHERE auction_id = $1)', [auctionId]);
    await dbQuery('DELETE FROM seller_payouts WHERE auction_id = $1', [auctionId]);
    await dbQuery('DELETE FROM lots           WHERE auction_id = $1', [auctionId]);
    await dbQuery('DELETE FROM auctions       WHERE id = $1', [auctionId]);
  }
  if (newBuyerEmail) {
    await dbQuery('DELETE FROM users WHERE email = $1', [newBuyerEmail]);
  }
  if (_pool) await _pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — API Setup: create auction → bid → close so we have a real winner
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 1 — API Setup', () => {
  test('login all four test accounts', async ({ request }) => {
    [sellerToken, adminToken, buyerAToken, buyerBToken] = await Promise.all([
      apiLogin(request, SELLER),
      apiLogin(request, ADMIN),
      apiLogin(request, BUYER_A),
      apiLogin(request, BUYER_B),
    ]);
  });

  test('get seller profile and buyer-a user ID', async ({ request }) => {
    const [spRes, meRes] = await Promise.all([
      request.get('/api/sellers/me', { headers: { Authorization: `Bearer ${sellerToken}` } }),
      request.get('/api/auth/me',    { headers: { Authorization: `Bearer ${buyerAToken}` } }).catch(() => null),
    ]);
    const spBody = await spRes.json();
    sellerProfileId = spBody.data.id;
    expect(sellerProfileId).toBeTruthy();

    // Decode buyer-a user ID from JWT
    const payload = JSON.parse(Buffer.from(buyerAToken.split('.')[1], 'base64').toString());
    buyerAUserId = payload.id;
    expect(buyerAUserId).toBeTruthy();
  });

  test('seller creates draft auction', async ({ request }) => {
    const { status, body } = await apiPost(request, sellerToken, '/api/auctions', {
      sellerProfileId,
      title: `Buyer Flow Test Auction ${Date.now()}`,
      state: 'draft',
    });
    expect(status).toBe(201);
    auctionId = body.data.id;
    expect(auctionId).toBeTruthy();
  });

  test('seller adds a lot', async ({ request }) => {
    const { status, body } = await apiPost(request, sellerToken, '/api/lots', {
      auctionId,
      title:              'Brass Telescope',
      starting_bid_cents: 500,
    });
    expect(status, `Create lot failed: ${body.message}`).toBe(201);
    lotId = body.data.id;
    expect(lotId).toBeTruthy();
  });

  test('admin publishes the auction', async ({ request }) => {
    const { status, body } = await apiPatch(request, adminToken, `/api/admin/auctions/${auctionId}/publish`, {});
    expect(status, `Publish failed: ${body.message || JSON.stringify(body)}`).toBe(200);
  });

  test('buyer-a places a bid', async ({ request }) => {
    const { status, body } = await apiPost(request, buyerAToken, `/api/lots/${lotId}/bids`, { amount: 10 });
    expect(status, `Bid failed: ${body.message}`).toBe(200);
  });

  test('admin closes the auction', async ({ request }) => {
    const { status, body } = await apiPost(request, adminToken, `/api/admin/auctions/${auctionId}/close`, {});
    expect(status, `Close failed: ${body.message || JSON.stringify(body)}`).toBe(200);
  });

  test('lot is closed and buyer-a is the winner', async ({ request }) => {
    const [rows] = await dbQuery(
      'SELECT state, winning_buyer_user_id, winning_amount_cents FROM lots WHERE id = $1',
      [lotId]
    );
    expect(rows.state).toBe('closed');
    expect(rows.winning_buyer_user_id).toBe(buyerAUserId);
    expect(rows.winning_amount_cents).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Registration (browser)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 2 — Registration', () => {
  test('new buyer can register via login.html UI', async ({ page }) => {
    newBuyerEmail = `buyer-flow-test-${Date.now()}@test.example.com`;
    const password = 'testpass123';

    await page.goto(`${BASE}/login.html`);
    await page.click('#tab-register');
    await page.fill('#reg-email',    newBuyerEmail);
    await page.fill('#reg-password', password);
    await page.fill('#reg-confirm',  password);
    await page.click('#register-btn');

    // Auto-login after registration redirects buyer to auction-view.html
    await page.waitForURL('**/auction-view.html', { timeout: 8_000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();
    newBuyerToken = token;
  });

  test('registration with duplicate email shows error', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.click('#tab-register');
    await page.fill('#reg-email',    BUYER_A.email);
    await page.fill('#reg-password', 'testpass123');
    await page.fill('#reg-confirm',  'testpass123');
    await page.click('#register-btn');

    await expect(page.locator('#register-error.visible')).toBeVisible({ timeout: 5_000 });
    const msg = await page.locator('#register-error').textContent();
    expect(msg).toMatch(/already exists/i);
  });

  test('registration with mismatched passwords shows error', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.click('#tab-register');
    await page.fill('#reg-email',    `other-${Date.now()}@test.example.com`);
    await page.fill('#reg-password', 'testpass123');
    await page.fill('#reg-confirm',  'different456');
    await page.click('#register-btn');

    await expect(page.locator('#register-error.visible')).toBeVisible({ timeout: 4_000 });
    expect(await page.locator('#register-error').textContent()).toMatch(/do not match/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Buyer Dashboard (browser)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 3 — Buyer Dashboard', () => {
  test('unauthenticated user is redirected from dashboard', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.removeItem('token'));
    await page.goto(`${BASE}/dashboard.html`);
    await page.waitForURL('**/login.html', { timeout: 6_000 });
  });

  test('dashboard.html loads for authenticated buyer', async ({ page }) => {
    await openPageAs(page, newBuyerToken, '/dashboard.html');
    await expect(page.locator('h1')).toContainText('My Purchases', { timeout: 6_000 });
  });

  test('new buyer sees empty state', async ({ page }) => {
    await openPageAs(page, newBuyerToken, '/dashboard.html');
    // Either empty-state text or the status-msg loading clears
    await expect(page.locator('body')).toContainText(/No purchases|Start bidding/i, { timeout: 8_000 });
  });

  test('dashboard has logout button', async ({ page }) => {
    await openPageAs(page, newBuyerToken, '/dashboard.html');
    await expect(page.locator('.logout-btn')).toBeVisible({ timeout: 6_000 });
  });

  test('GET /api/me/invoices returns empty array for new buyer', async ({ request }) => {
    const res  = await request.get('/api/me/invoices', {
      headers: { Authorization: `Bearer ${newBuyerToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.invoices)).toBe(true);
    expect(body.invoices.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — Invoice Detail Page Guard (browser)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 4 — Invoice Detail Guard', () => {
  test('/dashboard/invoice.html with no id shows error message', async ({ page }) => {
    await openPageAs(page, newBuyerToken, '/dashboard/invoice.html');
    await expect(page.locator('#status-msg.error')).toBeVisible({ timeout: 6_000 });
    expect(await page.locator('#status-msg').textContent()).toMatch(/No invoice ID/i);
  });

  test('/dashboard/invoice.html with unknown id shows not-found message', async ({ page }) => {
    await openPageAs(page, newBuyerToken, '/dashboard/invoice.html?id=nonexistent-id');
    // Page loads all invoices then searches — ends up with not-found state
    await expect(page.locator('#status-msg')).toContainText(/not found|No invoice/i, { timeout: 8_000 });
  });

  test('unauthenticated user is redirected from invoice detail', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.removeItem('token'));
    await page.goto(`${BASE}/dashboard/invoice.html?id=some-id`);
    await page.waitForURL('**/login.html', { timeout: 6_000 });
  });

  test('print button is present on invoice detail page', async ({ page }) => {
    await openPageAs(page, newBuyerToken, '/dashboard/invoice.html?id=some-id');
    await expect(page.locator('.print-btn')).toBeVisible({ timeout: 4_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Payment Gating (API)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 5 — Payment Gating', () => {
  test('unauthenticated request to charge-lot returns 401', async ({ request }) => {
    const res = await request.post('/api/payments/charge-lot', {
      data:    { auction_id: auctionId, lot_id: lotId },
      headers: { 'Idempotency-Key': 'unauth-test' },
    });
    expect(res.status()).toBe(401);
  });

  test('non-winner (buyer-b) cannot pay for buyer-a\'s lot', async ({ request }) => {
    const res = await request.post('/api/payments/charge-lot', {
      data:    { auction_id: auctionId, lot_id: lotId },
      headers: {
        Authorization:    `Bearer ${buyerBToken}`,
        'Idempotency-Key': `nonwinner-test-${Date.now()}`,
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.message || body.error).toMatch(/Only winning bidder/i);
  });

  test('winner (buyer-a) can initiate payment and receives client_secret', async ({ request }) => {
    const res = await request.post('/api/payments/charge-lot', {
      data:    { auction_id: auctionId, lot_id: lotId },
      headers: {
        Authorization:    `Bearer ${buyerAToken}`,
        'Idempotency-Key': `winner-pay-${lotId}`,
      },
    });
    const body = await res.json();
    expect(res.status(), `charge-lot failed: ${body.message}`).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.client_secret).toBeTruthy();
    expect(body.data.amount_cents).toBeGreaterThan(0);
  });

  test('GET /api/payments/config returns publishableKey field', async ({ request }) => {
    const res  = await request.get('/api/payments/config');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('publishableKey');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — Winner Pay Now Button (browser)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 6 — Winner Pay Now Button', () => {
  test('winner panel is visible on a closed lot', async ({ page }) => {
    await openPageAs(page, buyerAToken, `/lot.html?lotId=${lotId}`);
    await expect(page.locator('#winner-panel')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#winner-amount')).toContainText('$');
  });

  test('Pay Now button is visible for the winner (buyer-a)', async ({ page }) => {
    await openPageAs(page, buyerAToken, `/lot.html?lotId=${lotId}`);
    await expect(page.locator('#winner-panel')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#pay-btn')).toBeVisible({ timeout: 4_000 });
  });

  test('Pay Now button is NOT visible for non-winner (buyer-b)', async ({ page }) => {
    await openPageAs(page, buyerBToken, `/lot.html?lotId=${lotId}`);
    await expect(page.locator('#winner-panel')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('#pay-btn')).not.toBeVisible();
  });

  test('closed lot shows closed banner and disables bid input', async ({ page }) => {
    await openPageAs(page, buyerAToken, `/lot.html?lotId=${lotId}`);
    await expect(page.locator('#closed-banner')).toBeVisible({ timeout: 8_000 });
    const bidInput = page.locator('#bid-input');
    await expect(bidInput).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 — Logout (browser)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Phase 7 — Logout', () => {
  test('logout from dashboard clears token and redirects to login', async ({ page }) => {
    await openPageAs(page, newBuyerToken, '/dashboard.html');
    await expect(page.locator('.logout-btn')).toBeVisible({ timeout: 6_000 });
    await page.click('.logout-btn');
    await page.waitForURL('**/login.html', { timeout: 6_000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeNull();
  });

  test('login page has both login and register tabs', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await expect(page.locator('#tab-login')).toBeVisible();
    await expect(page.locator('#tab-register')).toBeVisible();
  });

  test('already-logged-in buyer is redirected from login page', async ({ page }) => {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), buyerAToken);
    await page.goto(`${BASE}/login.html`);
    // Should redirect away from login since token is valid
    await page.waitForURL(url => !url.href.endsWith('/login.html'), { timeout: 6_000 });
  });
});
