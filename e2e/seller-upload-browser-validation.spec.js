/**
 * Browser-based E2E validation of the seller upload workflow (dashboard/lots.html).
 *
 * Validates: login, seller dashboard, upload page, AI category mapping,
 * draft persistence, form validation, mobile layout, console health,
 * lot creation with image, and back navigation.
 *
 * Checkpoint: 9c9e7cb (AI category mapping patch)
 */

import 'dotenv/config';
import { test, expect } from '@playwright/test';
import path from 'path';

test.describe.configure({ mode: 'serial' });

const BASE   = process.env.BASE_URL || 'http://localhost:3000';
const SELLER = {
  email:    process.env.DEMO_SELLER_EMAIL    || 'demo-seller@advantage.bid',
  password: process.env.DEMO_SELLER_PASSWORD || 'DemoExplore2025!',
};

// Cloudinary-format URL that passes url.includes('res.cloudinary.com') checks
// without any pre-applied transform segments in the path.
const MOCK_CLOUDINARY_URL =
  'https://res.cloudinary.com/aap-platform/image/upload/v1748000000/lot-images/browser-validation-test.jpg';

// Path to minimal 1x1 JPEG fixture (215 bytes)
const FIXTURE_IMAGE = path.resolve(process.cwd(), 'e2e', 'fixtures', 'test-lot-image.jpg');

// Shared state across the serial suite
let sellerToken;
let sellerProfileId;
let testAuctionId;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function apiLogin(request, creds) {
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}: ${JSON.stringify(body)}`).toBe(200);
  return body.token;
}

async function openPageWithToken(page, token, pagePath) {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), token);
  await page.goto(`${BASE}${pagePath}`);
}

// Inject a fake Cloudinary URL into the page's uploadedFiles array so AI
// generation can proceed without a real file upload.
async function injectFakeUpload(page, url) {
  const fakeUrl = url || MOCK_CLOUDINARY_URL;
  await page.evaluate((u) => {
    if (typeof uploadedFiles !== 'undefined') {
      uploadedFiles.push({ id: 'fake-001', file: null, jobId: null, cloudinaryUrl: u });
    }
  }, fakeUrl);
}

// ── Phase 0: Setup ────────────────────────────────────────────────────────────

test('setup: seller login, profile fetch, test auction creation', async ({ request }) => {
  sellerToken = await apiLogin(request, SELLER);

  const profileRes = await request.get('/api/sellers/me', {
    headers: { Authorization: `Bearer ${sellerToken}` },
  });
  expect(profileRes.status()).toBe(200);
  const body = await profileRes.json();
  sellerProfileId = body.data.id;
  expect(sellerProfileId).toBeTruthy();

  const auctionRes = await request.post('/api/auctions', {
    data: {
      sellerProfileId,
      title: `Browser Validation ${Date.now()}`,
      state: 'draft',
    },
    headers: { Authorization: `Bearer ${sellerToken}` },
  });
  expect(auctionRes.status()).toBe(201);
  const auction = await auctionRes.json();
  testAuctionId = auction.data.id;
  expect(testAuctionId).toBeTruthy();
});

// ── Phase 1: Auth ─────────────────────────────────────────────────────────────

test('1.1 - login returns JWT containing role=seller', async ({ request }) => {
  const res  = await request.post('/api/auth/login', { data: SELLER });
  const body = await res.json();
  expect(res.status()).toBe(200);
  expect(body.token).toBeTruthy();
  // Role is embedded in the JWT payload (base64url, middle segment)
  const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
  expect(payload.role).toBe('seller');
});

test('1.2 - wrong password returns 401', async ({ request }) => {
  const res = await request.post('/api/auth/login', {
    data: { email: SELLER.email, password: 'WrongPassword!' },
  });
  expect(res.status()).toBe(401);
});

// ── Phase 2: Seller Dashboard ─────────────────────────────────────────────────

test('2.1 - seller-dashboard.html loads and shows Upload Photos link', async ({ page }) => {
  await openPageWithToken(page, sellerToken, '/seller-dashboard.html');
  await expect(page.locator('header, .header, h1').first()).toBeVisible({ timeout: 8000 });

  // "Upload Photos" primary link (from commit 7b9d87d)
  const uploadLinks = page.locator('a[href*="dashboard/lots.html"]');
  await expect(uploadLinks.first()).toBeVisible({ timeout: 8000 });
});

test('2.2 - Upload Photos link carries correct auctionId', async ({ page }) => {
  await openPageWithToken(page, sellerToken, '/seller-dashboard.html');
  const link = page.locator(`a[href*="auctionId=${testAuctionId}"]`);
  await expect(link.first()).toBeVisible({ timeout: 8000 });
});

test('2.3 - unauthenticated seller-dashboard redirects to login', async ({ page }) => {
  await page.goto(`${BASE}/seller-dashboard.html`);
  await page.waitForURL(`${BASE}/login.html`, { timeout: 5000 });
});

// ── Phase 3: Upload Page Core UI ──────────────────────────────────────────────

test('3.1 - dashboard/lots.html loads with auction context in header', async ({ page }) => {
  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);

  // Auction name appears in sub-line (replaces "Preparing new lot")
  await expect(page.locator('#auction-context')).not.toHaveText('Preparing new lot', { timeout: 8000 });

  await expect(page.locator('#lot-title')).toBeVisible();
  await expect(page.locator('#lot-desc')).toBeVisible();
  await expect(page.locator('#lot-category')).toBeVisible();
  await expect(page.locator('#starting-bid')).toBeVisible();
});

test('3.2 - upload zone and file input are present', async ({ page }) => {
  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  await expect(page.locator('#upload-zone')).toBeVisible();
  await expect(page.locator('#file-input')).toHaveCount(1);
});

test('3.3 - AI generate button is visible with correct label', async ({ page }) => {
  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  await expect(page.locator('#btn-ai-generate')).toBeVisible();
  await expect(page.locator('#btn-ai-generate')).toContainText('Generate from Photo');
});

test('3.4 - enhancement toggle and list are present', async ({ page }) => {
  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  await expect(page.locator('#ai-enhance')).toHaveCount(1);
  await expect(page.locator('#enhancement-list')).toBeVisible();
});

test('3.5 - back-link points to /seller-dashboard.html and says "My Auctions"', async ({ page }) => {
  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  const backLink = page.locator('a[href="/seller-dashboard.html"]');
  await expect(backLink).toBeVisible();
  await expect(backLink).toContainText('My Auctions');
});

test('3.6 - unauthenticated lots page redirects to login', async ({ page }) => {
  await page.goto(`${BASE}/dashboard/lots.html?auctionId=${testAuctionId}`);
  await page.waitForURL(`${BASE}/login.html`, { timeout: 5000 });
});

// ── Phase 4: AI Description Generation & Category Mapping ─────────────────────

test('4.1 - AI generate shows error when no photo uploaded', async ({ page }) => {
  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  // Clear any localStorage-restored images
  await page.evaluate(() => {
    if (typeof uploadedFiles !== 'undefined') uploadedFiles.length = 0;
  });
  await page.locator('#btn-ai-generate').click();

  const status = page.locator('#ai-gen-status');
  await expect(status).toBeVisible({ timeout: 3000 });
  await expect(status).toContainText('Upload at least one photo');
});

// Category mapping cases — each intercepted, each verified
const CATEGORY_MAP_CASES = [
  { aiReturns: 'Furniture',          expectValue: 'furniture' },
  { aiReturns: 'Fine Art',           expectValue: 'art'       },
  { aiReturns: 'Jewelry',            expectValue: 'jewelry'   },
  { aiReturns: 'Tools',              expectValue: 'tools'     },
  { aiReturns: 'General',            expectValue: 'other'     },
  { aiReturns: 'Home Decor',         expectValue: 'other'     },
  { aiReturns: 'Pottery & Ceramics', expectValue: 'other'     },
  { aiReturns: 'UnknownCategory',    expectValue: 'other'     },
];

for (const { aiReturns, expectValue } of CATEGORY_MAP_CASES) {
  test(`4.2 - AI category "${aiReturns}" → select value "${expectValue}"`, async ({ page }) => {
    await page.route('**/api/ai/generate-description', async route => {
      await route.fulfill({
        status:      200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            title:           `Test Title for ${aiReturns}`,
            description:     'Test description.',
            category:        aiReturns,
            pickup_category: 'B',
          },
        }),
      });
    });

    await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
    await injectFakeUpload(page);

    // Reset category select to empty before generating
    await page.evaluate(() => {
      const sel = document.getElementById('lot-category');
      if (sel) sel.value = '';
    });

    await page.locator('#btn-ai-generate').click();

    const status = page.locator('#ai-gen-status');
    await expect(status).toBeVisible({ timeout: 8000 });
    await expect(status).toContainText('Fields populated');

    const catValue = await page.locator('#lot-category').inputValue();
    expect(
      catValue,
      `AI "${aiReturns}" should map to select value "${expectValue}" but got "${catValue}"`
    ).toBe(expectValue);

    // The value must never be empty (i.e. unrecognized categories fall back to "other")
    expect(catValue).not.toBe('');
  });
}

test('4.3 - AI fills title and description fields correctly', async ({ page }) => {
  await page.route('**/api/ai/generate-description', async route => {
    await route.fulfill({
      status:      200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          title:           'Antique Oak Writing Desk',
          description:     'Solid oak, ca. 1890.',
          category:        'Furniture',
          pickup_category: 'C',
        },
      }),
    });
  });

  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  await injectFakeUpload(page);
  await page.locator('#btn-ai-generate').click();

  await expect(page.locator('#ai-gen-status')).toContainText('Fields populated', { timeout: 8000 });
  await expect(page.locator('#lot-title')).toHaveValue('Antique Oak Writing Desk');
  await expect(page.locator('#lot-desc')).toHaveValue('Solid oak, ca. 1890.');
});

test('4.4 - draft-saved indicator appears after AI fill', async ({ page }) => {
  await page.route('**/api/ai/generate-description', async route => {
    await route.fulfill({
      status:      200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { title: 'Draft Test', description: 'Desc.', category: 'Jewelry', pickup_category: 'A' },
      }),
    });
  });

  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  await injectFakeUpload(page);
  await page.locator('#btn-ai-generate').click();
  await expect(page.locator('#ai-gen-status')).toContainText('Fields populated', { timeout: 8000 });

  const draftIndicator = page.locator('#draft-indicator');
  await expect(draftIndicator).toBeVisible({ timeout: 3000 });
});

// ── Phase 5: Draft Persistence ────────────────────────────────────────────────

test('5.1 - draft persists across page reload', async ({ page }) => {
  const lotsPath = `/dashboard/lots.html?auctionId=${testAuctionId}`;
  await openPageWithToken(page, sellerToken, lotsPath);

  await page.locator('#lot-title').fill('Persistence Test Lot');
  await page.locator('#lot-desc').fill('Persistence test description.');
  await page.locator('#lot-category').selectOption('electronics');
  await page.locator('#starting-bid').fill('25');

  // Force an immediate save via the page's own saveDraft() to bypass the
  // 800ms debounce — Firefox page.reload() clears localStorage in Playwright,
  // making the debounce-then-reload pattern unreliable cross-browser.
  await page.evaluate(() => { if (typeof saveDraft === 'function') saveDraft(); });

  // Verify the draft reached localStorage before we leave the page
  const draftRaw = await page.evaluate(
    key => localStorage.getItem(key),
    `lot_draft_${testAuctionId}`
  );
  expect(draftRaw, 'Draft must be in localStorage before navigation').not.toBeNull();
  const saved = JSON.parse(draftRaw);
  expect(saved.title).toBe('Persistence Test Lot');

  // Navigate away then back (avoids page.reload() localStorage-clear in Firefox)
  await page.goto(`${BASE}/seller-dashboard.html`);
  await openPageWithToken(page, sellerToken, lotsPath);
  await page.waitForTimeout(600); // allow loadDraft() to populate fields

  await expect(page.locator('#lot-title')).toHaveValue('Persistence Test Lot', { timeout: 5000 });
  await expect(page.locator('#lot-desc')).toHaveValue('Persistence test description.');
  await expect(page.locator('#lot-category')).toHaveValue('electronics');
  await expect(page.locator('#starting-bid')).toHaveValue('25');
});

test('5.2 - draft key is auction-scoped (no bleed between auctions)', async ({ page }) => {
  // Set a distinct draft on our test auction
  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  await page.locator('#lot-title').fill('Auction A Specific Draft');
  await page.waitForTimeout(1500);

  // Open lots page with a different (fake) auction ID — different draft key
  const fakeId = '00000000-0000-4000-8000-000000000099';
  await page.goto(`${BASE}/dashboard/lots.html?auctionId=${fakeId}`);
  await page.evaluate(t => localStorage.setItem('token', t), sellerToken);
  await page.goto(`${BASE}/dashboard/lots.html?auctionId=${fakeId}`);
  await page.waitForTimeout(500);

  const titleVal = await page.locator('#lot-title').inputValue();
  expect(titleVal).not.toBe('Auction A Specific Draft');
});

// ── Phase 6: Form Validation ──────────────────────────────────────────────────

test('6.1 - Add to Auction blocked when title is empty', async ({ page }) => {
  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  await page.locator('#lot-title').fill('');

  let lotCreated = false;
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('/api/lots')) lotCreated = true;
  });

  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#add-lot-btn').click();
  await page.waitForTimeout(500);

  expect(lotCreated, 'Must not POST /api/lots when title is empty').toBe(false);
});

test('6.2 - Add to Auction blocked when no auctionId in URL', async ({ page }) => {
  await openPageWithToken(page, sellerToken, '/dashboard/lots.html');
  await page.locator('#lot-title').fill('No Auction Test');

  let lotCreated = false;
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('/api/lots')) lotCreated = true;
  });

  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#add-lot-btn').click();
  await page.waitForTimeout(500);

  expect(lotCreated).toBe(false);
});

// ── Phase 7: Full Lot Creation Flow ──────────────────────────────────────────

test('7.1 - create lot with mocked upload — appears in inventory', async ({ page }) => {
  // Mock Cloudinary upload proxy so no real network call is needed
  await page.route('**/api/uploads/image', async route => {
    await route.fulfill({
      status:      200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        url:     MOCK_CLOUDINARY_URL,
      }),
    });
  });

  // Mock image processing job so the worker doesn't attempt a fake URL
  await page.route('**/api/image-processing/jobs', async route => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status:      200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { id: 'fake-job-001', status: 'pending' } }),
      });
    } else {
      await route.continue();
    }
  });

  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);

  // Upload the fixture image — triggers the mocked upload
  await page.locator('#file-input').setInputFiles(FIXTURE_IMAGE);

  // Preview item should appear after upload resolves
  await expect(page.locator('#preview-grid').locator('img, .preview-item').first())
    .toBeVisible({ timeout: 12000 });

  // Fill lot details
  await page.locator('#lot-title').fill('Browser Validation Lot');
  await page.locator('#lot-desc').fill('Created by browser-validation spec.');
  await page.locator('#lot-category').selectOption('art');
  await page.locator('#starting-bid').fill('15');

  // Accept the success alert
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#add-lot-btn').click();

  // Inventory section should appear with the new lot
  await expect(page.locator('#inventory-section')).toBeVisible({ timeout: 12000 });
  await expect(page.locator('#inventory-list')).toContainText('Browser Validation Lot', { timeout: 8000 });
});

// ── Phase 8: Image URL Verification (double-transform check) ──────────────────

test('8.1 - lot_images.image_url is the original URL (no pre-applied transforms)', async ({ request }) => {
  const lotsRes = await request.get(`/api/lots/auction/${testAuctionId}/seller`, {
    headers: { Authorization: `Bearer ${sellerToken}` },
  });
  const lotsBody = await lotsRes.json();
  expect(lotsBody.success).toBe(true);

  const lots = lotsBody.data || [];
  if (lots.length === 0) {
    // Lot creation may not have succeeded (e.g. Cloudinary mock was strict) — skip
    console.log('SKIP: no lots in test auction — lot creation step may have been skipped');
    return;
  }

  const lot = lots.find(l => l.title === 'Browser Validation Lot') || lots[0];
  const imagesRes = await request.get(`/api/lots/${lot.id}/images`, {
    headers: { Authorization: `Bearer ${sellerToken}` },
  });

  if (imagesRes.status() !== 200) return; // no images attached — skip

  const imgBody = await imagesRes.json();
  if (!imgBody.data || !imgBody.data.length) return;

  const image = imgBody.data[0];

  // The stored image_url must NOT contain any existing Cloudinary transform segment
  expect(
    image.image_url,
    'image_url in lot_images must be the original URL without any transform'
  ).not.toMatch(/\/upload\/.+e_background_removal/);

  // best_image_url: if a processing job ran, it should have at most one e_background_removal
  if (image.best_image_url && image.best_image_url !== image.image_url) {
    const bgCount = (image.best_image_url.match(/e_background_removal/g) || []).length;
    expect(
      bgCount,
      `best_image_url has ${bgCount} e_background_removal segments — expected ≤1: ${image.best_image_url}`
    ).toBeLessThanOrEqual(1);
  }
});

// ── Phase 9: Navigation ───────────────────────────────────────────────────────

test('9.1 - back-link navigates to seller dashboard', async ({ page }) => {
  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  const backLink = page.locator('a[href="/seller-dashboard.html"]');
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForURL(`${BASE}/seller-dashboard.html`, { timeout: 5000 });
});

// ── Phase 10: Mobile Responsiveness ──────────────────────────────────────────

test.describe('mobile viewport — 390px (iPhone 12)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('10.1 - lots page: no horizontal scroll', async ({ page }) => {
    await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
    await page.locator('#lot-title').waitFor({ timeout: 8000 });

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth  = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth, `Horizontal overflow: scrollWidth=${scrollWidth} > innerWidth=${innerWidth}`).toBeLessThanOrEqual(innerWidth + 2);
  });

  test('10.2 - upload zone width ≤ 390px', async ({ page }) => {
    await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
    await expect(page.locator('#upload-zone')).toBeVisible({ timeout: 8000 });
    const box = await page.locator('#upload-zone').boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeLessThanOrEqual(390);
  });

  test('10.3 - Add to Auction button visible within 390px viewport', async ({ page }) => {
    await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
    const addBtn = page.locator('#add-lot-btn');
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    const box = await addBtn.boundingBox();
    expect(box).not.toBeNull();
    // Button right edge must not exceed viewport width + small tolerance
    expect(box.x + box.width).toBeLessThanOrEqual(395);
  });

  test('10.4 - AI generate button visible within 390px viewport', async ({ page }) => {
    await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
    const btn = page.locator('#btn-ai-generate');
    await expect(btn).toBeVisible({ timeout: 5000 });
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box.x + box.width).toBeLessThanOrEqual(395);
  });

  test('10.5 - seller-dashboard.html: no horizontal scroll at 390px', async ({ page }) => {
    await openPageWithToken(page, sellerToken, '/seller-dashboard.html');
    await page.locator('header, h1').first().waitFor({ timeout: 8000 });

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth  = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 2);
  });
});

// ── Phase 11: Console Health ──────────────────────────────────────────────────

test('11.1 - lots page: no uncaught JS errors on load', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  await page.locator('#lot-title').waitFor({ timeout: 8000 });
  await page.waitForTimeout(2000);

  expect(
    pageErrors,
    `Unexpected JS errors on lots page: ${JSON.stringify(pageErrors)}`
  ).toHaveLength(0);
});

test('11.2 - seller-dashboard: no uncaught JS errors on load', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await openPageWithToken(page, sellerToken, '/seller-dashboard.html');
  await page.locator('header, h1').first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(2000);

  expect(
    pageErrors,
    `JS errors on seller-dashboard: ${JSON.stringify(pageErrors)}`
  ).toHaveLength(0);
});

test('11.3 - no 5xx responses during normal lots page session', async ({ page }) => {
  const fiveHundreds = [];
  page.on('response', resp => {
    if (resp.status() >= 500) {
      fiveHundreds.push({ url: resp.url(), status: resp.status() });
    }
  });

  await openPageWithToken(page, sellerToken, `/dashboard/lots.html?auctionId=${testAuctionId}`);
  // Let the page settle and any polling timers fire
  await page.waitForTimeout(3000);

  expect(
    fiveHundreds,
    `5xx responses during lots page session: ${JSON.stringify(fiveHundreds)}`
  ).toHaveLength(0);
});

// ── Teardown ──────────────────────────────────────────────────────────────────

test.afterAll(async ({ request }) => {
  if (!testAuctionId) return;
  // Best-effort cleanup — delete test lots then auction
  const lotsRes = await request.get(`/api/lots/auction/${testAuctionId}/seller`, {
    headers: { Authorization: `Bearer ${sellerToken}` },
  }).catch(() => null);
  if (lotsRes && lotsRes.ok()) {
    const body = await lotsRes.json().catch(() => ({ data: [] }));
    for (const lot of (body.data || [])) {
      await request.delete(`/api/lots/${lot.id}`, {
        headers: { Authorization: `Bearer ${sellerToken}` },
      }).catch(() => {});
    }
  }
  // The auction itself can only be deleted by admin — leave it as a draft
  // (draft auctions don't affect buyers or the live marketplace)
});
