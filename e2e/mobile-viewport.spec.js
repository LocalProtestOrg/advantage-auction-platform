import 'dotenv/config';
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

// iPhone 12 form factor — 390px wide
test.use({ viewport: { width: 390, height: 844 } });

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const SELLER = { email: 'rehearsal-seller@test.com', password: 'rehearsal123' };
const BUYER_A = { email: 'rehearsal-buyer-a@test.com', password: 'rehearsal123' };

async function apiLogin(request, creds) {
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}: ${body.error}`).toBe(200);
  return body.token;
}

async function openPageAs(page, token, path) {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), token);
  await page.goto(`${BASE}${path}`);
}

// Returns true if no horizontal scrollbar (document not wider than viewport)
function noHScroll(page) {
  return page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 2
  );
}

// Returns the bounding box width of an element relative to the viewport
async function elWidth(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  return box ? box.width : null;
}

// ── Tokens ───────────────────────────────────────────────────────────────────
let sellerToken;
let buyerToken;

test('setup: acquire tokens', async ({ request }) => {
  sellerToken = await apiLogin(request, SELLER);
  buyerToken  = await apiLogin(request, BUYER_A);
});

// ── Public pages ─────────────────────────────────────────────────────────────

test('login page: card within 390px, no horizontal scroll', async ({ page }) => {
  await page.goto(`${BASE}/login.html`);
  await expect(page.locator('.card')).toBeVisible();
  const w = await elWidth(page, '.card');
  expect(w).toBeLessThanOrEqual(390);
  expect(await noHScroll(page)).toBe(true);
});

test('payment page: card within 390px, no horizontal scroll', async ({ page }) => {
  await page.goto(`${BASE}/payment.html`);
  await expect(page.locator('.card')).toBeVisible();
  const w = await elWidth(page, '.card');
  expect(w).toBeLessThanOrEqual(390);
  expect(await noHScroll(page)).toBe(true);
});

test('auction-view page: header within viewport, no horizontal scroll', async ({ page }) => {
  await page.goto(`${BASE}/auction-view.html`);
  await expect(page.locator('header')).toBeVisible();
  const w = await elWidth(page, 'header');
  expect(w).toBeLessThanOrEqual(390);
  expect(await noHScroll(page)).toBe(true);
});

// ── Lot page layout ───────────────────────────────────────────────────────────

test('lot page: layout collapses to single column (bid-panel below image-col)', async ({ page }) => {
  // lot.html requires auth — inject token before navigating
  await openPageAs(page, buyerToken, '/lot.html');
  await expect(page.locator('.layout')).toBeVisible();

  const imgBox = await page.locator('.image-col').boundingBox();
  const panBox = await page.locator('.bid-panel').boundingBox();
  expect(imgBox).not.toBeNull();
  expect(panBox).not.toBeNull();

  // Single-column: bid-panel top must be at or below image-col bottom
  expect(panBox.y).toBeGreaterThanOrEqual(imgBox.y + imgBox.height - 10);
});

test('lot page: no horizontal scroll', async ({ page }) => {
  await openPageAs(page, buyerToken, '/lot.html');
  expect(await noHScroll(page)).toBe(true);
});

// ── Auth-gated pages ──────────────────────────────────────────────────────────

test('seller-dashboard: header and cards within viewport, no horizontal scroll', async ({ page }) => {
  await openPageAs(page, sellerToken, '/seller-dashboard.html');
  await expect(page.locator('header')).toBeVisible();
  const headerW = await elWidth(page, 'header');
  expect(headerW).toBeLessThanOrEqual(390);
  expect(await noHScroll(page)).toBe(true);
});

test('buyer dashboard: purchases page within viewport, no horizontal scroll', async ({ page }) => {
  await openPageAs(page, buyerToken, '/dashboard.html');
  await expect(page.locator('header')).toBeVisible();
  const headerW = await elWidth(page, 'header');
  expect(headerW).toBeLessThanOrEqual(390);
  expect(await noHScroll(page)).toBe(true);
});

test('invoice page: card within viewport, no horizontal scroll', async ({ page }) => {
  await openPageAs(page, buyerToken, '/dashboard/invoice.html');
  await expect(page.locator('.page')).toBeVisible();
  expect(await noHScroll(page)).toBe(true);
});
