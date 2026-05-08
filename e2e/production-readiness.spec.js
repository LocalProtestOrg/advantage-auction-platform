import 'dotenv/config';
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const BUYER_A = { email: 'rehearsal-buyer-a@test.com', password: 'rehearsal123' };

const EXPIRED_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpZCI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMCIsInJvbGUiOiJidXllciIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMDAxfQ.' +
  'invalidsignature';

const INVALID_TOKEN = 'not-a-jwt-at-all';

async function apiLogin(request, creds) {
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}`).toBe(200);
  return body.token;
}

async function injectToken(page, token, path) {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), token);
  await page.goto(`${BASE}${path}`);
}

// ── API: auth middleware returns 401 (not 403) ────────────────────────────────

test('API: missing token → 401', async ({ request }) => {
  const res = await request.post('/api/lots/some-lot/bids', {
    data: { amount: 100 },
  });
  expect(res.status()).toBe(401);
  const body = await res.json();
  expect(body.error).toBeTruthy();
});

test('API: expired/invalid token → 401', async ({ request }) => {
  const res = await request.get('/api/sellers/me', {
    headers: { Authorization: `Bearer ${EXPIRED_TOKEN}` },
  });
  expect(res.status()).toBe(401);
  const body = await res.json();
  expect(body.error).toMatch(/session expired|invalid token/i);
});

test('API: malformed token → 401', async ({ request }) => {
  const res = await request.get('/api/sellers/me', {
    headers: { Authorization: `Bearer ${INVALID_TOKEN}` },
  });
  expect(res.status()).toBe(401);
});

// ── Browser: expired session redirects to login ───────────────────────────────

test('browser: expired session on dashboard.html → redirected to login', async ({ page }) => {
  await injectToken(page, EXPIRED_TOKEN, '/dashboard.html');
  // 401 from /api/me/invoices should trigger logout() → redirect
  await page.waitForURL('**/login.html', { timeout: 6000 });
  await expect(page.locator('.card')).toBeVisible();
});

test('browser: expired session on seller-dashboard.html → redirected to login', async ({ page }) => {
  await injectToken(page, EXPIRED_TOKEN, '/seller-dashboard.html');
  await page.waitForURL('**/login.html', { timeout: 6000 });
  await expect(page.locator('.card')).toBeVisible();
});

test('browser: expired session on lot.html → redirected to login', async ({ page }) => {
  // lot.html redirects on missing token before hitting API if token is absent
  // With expired token, it should redirect after the initial fetch returns 401
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), EXPIRED_TOKEN);
  await page.goto(`${BASE}/lot.html?lotId=00000000-0000-0000-0000-000000000001`);
  await page.waitForURL('**/login.html', { timeout: 6000 });
  await expect(page.locator('.card')).toBeVisible();
});

test('browser: expired session on invoice.html → redirected to login', async ({ page }) => {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), EXPIRED_TOKEN);
  await page.goto(`${BASE}/dashboard/invoice.html?id=00000000-0000-0000-0000-000000000001`);
  await page.waitForURL('**/login.html', { timeout: 6000 });
  await expect(page.locator('.card')).toBeVisible();
});

// ── Missing resource handling ─────────────────────────────────────────────────

test('API: unknown lot returns 404', async ({ request }) => {
  const res = await request.get('/api/lots/00000000-0000-0000-0000-000000000000');
  expect(res.status()).toBe(404);
});

test('browser: lot.html with no lotId shows descriptive message', async ({ page }) => {
  let buyerToken;
  const res = await page.request.post('/api/auth/login', { data: BUYER_A });
  const body = await res.json();
  buyerToken = body.token;
  await injectToken(page, buyerToken, '/lot.html');
  // No lotId param → should show informative message in loading overlay
  await expect(page.locator('#loading-overlay')).toContainText(/No lot ID/i);
});

test('browser: payment.html with no client_secret shows informative message', async ({ page }) => {
  await page.goto(`${BASE}/payment.html`);
  // No client_secret → should show the "Missing payment details" message
  const form = page.locator('#payment-form');
  await expect(form).toContainText(/Missing payment details|Return to the auction/i);
});

test('browser: auction-view.html with no auctionId shows informative message', async ({ page }) => {
  await page.goto(`${BASE}/auction-view.html`);
  await expect(page.locator('#lot-grid')).toContainText(/No auction selected|Check the URL/i);
});

// ── API: payment failure messaging ───────────────────────────────────────────

test('API: charge-lot with non-existent lot returns descriptive error', async ({ request }) => {
  const loginRes = await request.post('/api/auth/login', { data: BUYER_A });
  const { token } = await loginRes.json();

  const res = await request.post('/api/payments/charge-lot', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'prod-readiness-test-' + Date.now(),
    },
    data: {
      auction_id: '00000000-0000-0000-0000-000000000000',
      lot_id:     '00000000-0000-0000-0000-000000000000',
    },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.message).toBeTruthy();
});

// ── API: config endpoint (public, no auth) ────────────────────────────────────

test('API: /api/payments/config returns publishableKey without auth', async ({ request }) => {
  const res  = await request.get('/api/payments/config');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('publishableKey');
  expect(typeof body.publishableKey).toBe('string');
});
