import 'dotenv/config';
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Canonical validation identities (seeded by scripts/seed-validation-fixtures.js)
const ADMIN_CREDS  = { email: 'validation-admin@advantage.bid', password: 'ValidationAdmin2025!' };
const BUYER_CREDS  = { email: 'validation-buyer@advantage.bid', password: 'ValidationBuyer2025!' };
const SELLER_CREDS = { email: 'demo-seller@advantage.bid',      password: 'DemoExplore2025!' };

// Demo auction seeded by scripts/seed-demo-data.js — closed, owned by demo-seller
const DEMO_AUCTION_ID = 'dd000000-0000-4000-8000-000000000010';

// Shared state — populated by setup test, consumed by subsequent tests
let adminToken  = null;
let buyerToken  = null;
let sellerToken = null;
let testVideoId = null;   // video created during workflow tests
let video2Id    = null;   // second video for queue-count tests

const EXPIRED_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpZCI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMCIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMDAxfQ.' +
  'invalidsignature';

async function loginUser(request, creds) {
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}: ${JSON.stringify(body)}`).toBe(200);
  expect(body.token, `No token for ${creds.email}`).toBeTruthy();
  return body.token;
}

// ── 1. Setup ───────────────────────────────────────────────────────────────────

test('setup: login all three canonical accounts', async ({ request }) => {
  [adminToken, buyerToken, sellerToken] = await Promise.all([
    loginUser(request, ADMIN_CREDS),
    loginUser(request, BUYER_CREDS),
    loginUser(request, SELLER_CREDS),
  ]);
  expect(adminToken).toBeTruthy();
  expect(buyerToken).toBeTruthy();
  expect(sellerToken).toBeTruthy();
});

// ── 2. Role enforcement — /api/admin/videos ────────────────────────────────────

test('GET /api/admin/videos: no token → 401', async ({ request }) => {
  const res = await request.get('/api/admin/videos');
  expect(res.status()).toBe(401);
});

test('GET /api/admin/videos: buyer token → 403', async ({ request }) => {
  const res = await request.get('/api/admin/videos', {
    headers: { Authorization: `Bearer ${buyerToken}` },
  });
  expect(res.status()).toBe(403);
});

test('GET /api/admin/videos: seller token → 403', async ({ request }) => {
  const res = await request.get('/api/admin/videos', {
    headers: { Authorization: `Bearer ${sellerToken}` },
  });
  expect(res.status()).toBe(403);
});

test('GET /api/admin/videos: expired token → 401', async ({ request }) => {
  const res = await request.get('/api/admin/videos', {
    headers: { Authorization: `Bearer ${EXPIRED_TOKEN}` },
  });
  expect(res.status()).toBe(401);
});

test('GET /api/admin/videos: admin token → 200 with data array', async ({ request }) => {
  const res  = await request.get('/api/admin/videos', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data)).toBe(true);
});

// ── 3. Role enforcement — /api/admin/videos/pending ───────────────────────────

test('GET /api/admin/videos/pending: no token → 401', async ({ request }) => {
  const res = await request.get('/api/admin/videos/pending');
  expect(res.status()).toBe(401);
});

test('GET /api/admin/videos/pending: buyer → 403', async ({ request }) => {
  const res = await request.get('/api/admin/videos/pending', {
    headers: { Authorization: `Bearer ${buyerToken}` },
  });
  expect(res.status()).toBe(403);
});

test('GET /api/admin/videos/pending: admin → 200 with data array', async ({ request }) => {
  const res  = await request.get('/api/admin/videos/pending', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data)).toBe(true);
});

// ── 4. Role enforcement — moderation actions ───────────────────────────────────

test('POST /api/admin/videos/:id/approve: buyer → 403', async ({ request }) => {
  const res = await request.post('/api/admin/videos/00000000-0000-4000-8000-000000000001/approve', {
    headers: { Authorization: `Bearer ${buyerToken}` },
  });
  expect(res.status()).toBe(403);
});

test('POST /api/admin/videos/:id/reject: seller → 403', async ({ request }) => {
  const res = await request.post('/api/admin/videos/00000000-0000-4000-8000-000000000001/reject', {
    headers: { Authorization: `Bearer ${sellerToken}` },
    data: { reason: 'test' },
  });
  expect(res.status()).toBe(403);
});

test('PATCH /api/admin/videos/:id/visibility: no token → 401', async ({ request }) => {
  const res = await request.patch('/api/admin/videos/00000000-0000-4000-8000-000000000001/visibility', {
    data: { visible: true },
  });
  expect(res.status()).toBe(401);
});

// ── 5. Moderation workflow — submit test video ─────────────────────────────────

test('seller submits walkthrough video to demo auction', async ({ request }) => {
  const res = await request.post(`/api/auctions/${DEMO_AUCTION_ID}/walkthrough-video`, {
    headers: { Authorization: `Bearer ${sellerToken}` },
    data: {
      video_url: 'https://example.com/validation-test-video.mp4',
      title:     'Validation Test Video',
      caption:   'Created by admin-moderation.spec.js — safe to delete',
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.review_status).toBe('pending_review');
  expect(body.data.visible_public).toBe(false);
  expect(body.data.featured_for_marketing).toBe(false);
  testVideoId = body.data.id;
  expect(testVideoId).toBeTruthy();
});

// ── 6. Pending queue contains the new video ────────────────────────────────────

test('GET /api/admin/videos/pending: new video appears in queue', async ({ request }) => {
  const res  = await request.get('/api/admin/videos/pending', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  const found = body.data.find(v => v.id === testVideoId);
  expect(found, `testVideoId ${testVideoId} not found in pending queue`).toBeTruthy();
  expect(found.review_status).toBe('pending_review');
  expect(found.auction_title).toBeTruthy();
});

test('GET /api/admin/videos?status=pending_review: new video appears', async ({ request }) => {
  const res  = await request.get('/api/admin/videos?status=pending_review', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  expect(body.success).toBe(true);
  const found = body.data.find(v => v.id === testVideoId);
  expect(found).toBeTruthy();
});

test('GET /api/admin/videos (all): new video appears', async ({ request }) => {
  const res  = await request.get('/api/admin/videos', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  expect(body.data.find(v => v.id === testVideoId)).toBeTruthy();
});

test('GET /api/admin/videos?status=approved: new video NOT in approved list', async ({ request }) => {
  const res  = await request.get('/api/admin/videos?status=approved', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  expect(body.data.find(v => v.id === testVideoId)).toBeFalsy();
});

// ── 7. Public endpoint gating — before approval ───────────────────────────────

test('public-video endpoint returns null before approval', async ({ request }) => {
  const res  = await request.get(`/api/auctions/${DEMO_AUCTION_ID}/public-video`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  // May return another approved video from demo data, but our pending one should not be there
  if (body.data) {
    expect(body.data.id).not.toBe(testVideoId);
  }
});

// ── 8. Approve video ──────────────────────────────────────────────────────────

test('POST /approve: admin approves test video', async ({ request }) => {
  const res  = await request.post(`/api/admin/videos/${testVideoId}/approve`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.review_status).toBe('approved');
  expect(body.data.visible_public).toBe(false);         // approve does NOT auto-publish
  expect(body.data.featured_for_marketing).toBe(false);
  expect(body.data.approved_at).toBeTruthy();
});

test('approved video leaves pending queue', async ({ request }) => {
  const res  = await request.get('/api/admin/videos/pending', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  expect(body.data.find(v => v.id === testVideoId)).toBeFalsy();
});

test('approved video appears in approved filter', async ({ request }) => {
  const res  = await request.get('/api/admin/videos?status=approved', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  expect(body.data.find(v => v.id === testVideoId)).toBeTruthy();
});

test('public-video endpoint still returns null after approve (not yet published)', async ({ request }) => {
  const res  = await request.get(`/api/auctions/${DEMO_AUCTION_ID}/public-video`);
  const body = await res.json();
  // Our video is approved but visible_public=false, should not be returned
  if (body.data) {
    expect(body.data.id).not.toBe(testVideoId);
  }
});

// ── 9. Visibility toggle ──────────────────────────────────────────────────────

test('PATCH /visibility {visible:true}: missing visible field → 400', async ({ request }) => {
  const res = await request.patch(`/api/admin/videos/${testVideoId}/visibility`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {},
  });
  expect(res.status()).toBe(400);
});

test('PATCH /visibility {visible:true}: admin makes video public', async ({ request }) => {
  const res  = await request.patch(`/api/admin/videos/${testVideoId}/visibility`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { visible: true },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.visible_public).toBe(true);
});

test('public-video endpoint returns video after visibility=true', async ({ request }) => {
  const res  = await request.get(`/api/auctions/${DEMO_AUCTION_ID}/public-video`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  // There may be multiple approved+visible videos; ours should be one of them
  // The endpoint returns the most recently approved — we just ensure success structure
  expect(body.success).toBe(true);
  expect(body.data).not.toBeNull();
});

// ── 10. Featured toggle ───────────────────────────────────────────────────────

test('PATCH /featured {featured:true}: admin features the video', async ({ request }) => {
  const res  = await request.patch(`/api/admin/videos/${testVideoId}/featured`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { featured: true },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.featured_for_marketing).toBe(true);
});

test('PATCH /featured {featured:false}: admin unfeatures the video', async ({ request }) => {
  const res  = await request.patch(`/api/admin/videos/${testVideoId}/featured`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { featured: false },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.featured_for_marketing).toBe(false);
});

test('PATCH /featured: missing featured field → 400', async ({ request }) => {
  const res = await request.patch(`/api/admin/videos/${testVideoId}/featured`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {},
  });
  expect(res.status()).toBe(400);
});

// ── 11. Unpublish ─────────────────────────────────────────────────────────────

test('PATCH /visibility {visible:false}: admin unpublishes video', async ({ request }) => {
  const res  = await request.patch(`/api/admin/videos/${testVideoId}/visibility`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { visible: false },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.visible_public).toBe(false);
});

// ── 12. Reject (from approved state) ─────────────────────────────────────────

test('POST /reject: admin rejects approved video with reason', async ({ request }) => {
  const res  = await request.post(`/api/admin/videos/${testVideoId}/reject`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { reason: 'Validation test rejection — safe to ignore' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.review_status).toBe('rejected');
  expect(body.data.visible_public).toBe(false);
  expect(body.data.featured_for_marketing).toBe(false);
  expect(body.data.rejection_reason).toBe('Validation test rejection — safe to ignore');
});

test('rejected video appears in rejected filter', async ({ request }) => {
  const res  = await request.get('/api/admin/videos?status=rejected', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  expect(body.data.find(v => v.id === testVideoId)).toBeTruthy();
});

test('rejected video NOT in pending queue', async ({ request }) => {
  const res  = await request.get('/api/admin/videos/pending', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  expect(body.data.find(v => v.id === testVideoId)).toBeFalsy();
});

// ── 13. Visibility/featured blocked on rejected video ─────────────────────────

test('PATCH /visibility on rejected video → 404 (not approved)', async ({ request }) => {
  const res = await request.patch(`/api/admin/videos/${testVideoId}/visibility`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { visible: true },
  });
  // Service requires review_status='approved' — rejected video returns no row → 404
  expect(res.status()).toBe(404);
});

// ── 14. Queue count behavior ──────────────────────────────────────────────────

test('setup: seller submits second video for queue-count test', async ({ request }) => {
  const res  = await request.post(`/api/auctions/${DEMO_AUCTION_ID}/walkthrough-video`, {
    headers: { Authorization: `Bearer ${sellerToken}` },
    data: {
      video_url: 'https://example.com/validation-test-video-2.mp4',
      title:     'Validation Test Video 2',
      caption:   'Queue-count validation — safe to delete',
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  video2Id = body.data.id;
  expect(video2Id).toBeTruthy();
});

test('pending queue contains the second video', async ({ request }) => {
  const res  = await request.get('/api/admin/videos/pending', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  expect(body.data.find(v => v.id === video2Id)).toBeTruthy();
});

test('approve second video removes it from pending', async ({ request }) => {
  const approveRes = await request.post(`/api/admin/videos/${video2Id}/approve`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(approveRes.status()).toBe(200);

  const queueRes = await request.get('/api/admin/videos/pending', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await queueRes.json();
  expect(body.data.find(v => v.id === video2Id)).toBeFalsy();
});

// ── 15. Unknown video ID ──────────────────────────────────────────────────────

test('POST /approve on unknown video → 404', async ({ request }) => {
  const res = await request.post('/api/admin/videos/00000000-0000-4000-8000-000000000099/approve', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(404);
});

test('POST /reject on unknown video → 404', async ({ request }) => {
  const res = await request.post('/api/admin/videos/00000000-0000-4000-8000-000000000099/reject', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { reason: 'test' },
  });
  expect(res.status()).toBe(404);
});

// ── 16. Diagnostics APIs ──────────────────────────────────────────────────────

test('GET /api/admin/diagnostics/auctions: structure check', async ({ request }) => {
  const res  = await request.get('/api/admin/diagnostics/auctions', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data.auction_states)).toBe(true);
  expect(typeof body.data.open_lots).toBe('number');
  expect(Array.isArray(body.data.recent_auctions)).toBe(true);
  if (body.data.recent_auctions.length > 0) {
    const a = body.data.recent_auctions[0];
    expect(a).toHaveProperty('id');
    expect(a).toHaveProperty('title');
    expect(a).toHaveProperty('state');
    expect(typeof a.lot_count).toBe('number');
  }
});

test('GET /api/admin/diagnostics/payments: structure check', async ({ request }) => {
  const res  = await request.get('/api/admin/diagnostics/payments', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data.by_status)).toBe(true);
  expect(Array.isArray(body.data.recent_payments)).toBe(true);
});

test('GET /api/admin/diagnostics/notifications: structure check', async ({ request }) => {
  const res  = await request.get('/api/admin/diagnostics/notifications', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data.by_status)).toBe(true);
  expect(typeof body.data.queue_depth).toBe('number');
  expect(Array.isArray(body.data.recent_notifications)).toBe(true);
});

// ── 17. Seller search ─────────────────────────────────────────────────────────

test('GET /api/admin/sellers: returns array of sellers', async ({ request }) => {
  const res  = await request.get('/api/admin/sellers', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /api/admin/sellers?search=demo: finds demo-seller', async ({ request }) => {
  const res  = await request.get('/api/admin/sellers?search=demo-seller', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.length).toBeGreaterThan(0);
  const seller = body.data.find(s => s.email === SELLER_CREDS.email);
  expect(seller).toBeTruthy();
  expect(seller).toHaveProperty('seller_profile_id');
  expect(typeof seller.auction_count).toBe('number');
});

test('GET /api/admin/sellers?search=nonexistent: returns empty array', async ({ request }) => {
  const res  = await request.get('/api/admin/sellers?search=zzznobodyx99@nowhere.invalid', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.length).toBe(0);
});

test('GET /api/admin/sellers: buyer → 403', async ({ request }) => {
  const res = await request.get('/api/admin/sellers', {
    headers: { Authorization: `Bearer ${buyerToken}` },
  });
  expect(res.status()).toBe(403);
});

// ── 18. Payouts ───────────────────────────────────────────────────────────────

test('GET /api/admin/payouts: returns 200 with data array', async ({ request }) => {
  const res  = await request.get('/api/admin/payouts', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /api/admin/payouts?status=pending: filtered correctly', async ({ request }) => {
  const res  = await request.get('/api/admin/payouts?status=pending', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  body.data.forEach(p => expect(p.payout_status).toBe('pending'));
});

test('GET /api/admin/payouts?status=invalid: 400 error', async ({ request }) => {
  const res = await request.get('/api/admin/payouts?status=invalid', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(400);
});

test('GET /api/admin/payouts: buyer → 403', async ({ request }) => {
  const res = await request.get('/api/admin/payouts', {
    headers: { Authorization: `Bearer ${buyerToken}` },
  });
  expect(res.status()).toBe(403);
});

// ── 19. /api/admin/videos ?status= filtering ──────────────────────────────────

test('GET /api/admin/videos?status=rejected: only rejected videos returned', async ({ request }) => {
  const res  = await request.get('/api/admin/videos?status=rejected', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  body.data.forEach(v => expect(v.review_status).toBe('rejected'));
});

test('GET /api/admin/videos?status=approved: only approved videos returned', async ({ request }) => {
  const res  = await request.get('/api/admin/videos?status=approved', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  body.data.forEach(v => expect(v.review_status).toBe('approved'));
});

test('GET /api/admin/videos?status=badvalue: ignored → returns all', async ({ request }) => {
  const res  = await request.get('/api/admin/videos?status=badvalue', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  // Invalid status is whitelisted — returns all videos (no WHERE clause injected)
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data)).toBe(true);
});

// ── 20. UI browser tests ──────────────────────────────────────────────────────

test('browser: /admin/moderation.html with no token → Access Denied or redirected', async ({ page }) => {
  await page.goto(`${BASE}/admin/moderation.html`);
  // Page should either redirect to login or show access denied in body
  const url = page.url();
  const bodyText = await page.textContent('body');
  const blocked = url.includes('login.html') || /access denied/i.test(bodyText);
  expect(blocked, `Expected redirect or access denied, got URL=${url}`).toBe(true);
});

test('browser: /admin/moderation.html with buyer token → Access Denied', async ({ page }) => {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), buyerToken);
  await page.goto(`${BASE}/admin/moderation.html`);
  await expect(page.locator('body')).toContainText(/access denied/i, { timeout: 4000 });
});

test('browser: /admin/moderation.html with admin token → page loads', async ({ page }) => {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), adminToken);
  await page.goto(`${BASE}/admin/moderation.html`);
  await expect(page.locator('h1')).toContainText('Admin Moderation', { timeout: 6000 });
  await expect(page.locator('.tabs')).toBeVisible();
});

test('browser: Queue tab is active by default and loads content', async ({ page }) => {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), adminToken);
  await page.goto(`${BASE}/admin/moderation.html`);
  await expect(page.locator('#tab-queue')).toHaveClass(/active/, { timeout: 6000 });
  // Status message should clear after load (empty state or cards)
  await expect(page.locator('#queue-status')).not.toContainText('Loading', { timeout: 6000 });
});

test('browser: clicking All Videos tab switches panel', async ({ page }) => {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), adminToken);
  await page.goto(`${BASE}/admin/moderation.html`);
  await page.waitForSelector('.tabs', { timeout: 6000 });

  await page.click('[data-tab="videos"]');
  await expect(page.locator('#tab-videos')).toHaveClass(/active/);
  await expect(page.locator('#tab-queue')).not.toHaveClass(/active/);
  // Videos tab should load (no perpetual loading state)
  await expect(page.locator('#videos-status')).not.toContainText('Loading', { timeout: 8000 });
});

test('browser: clicking Auctions tab shows state chips', async ({ page }) => {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), adminToken);
  await page.goto(`${BASE}/admin/moderation.html`);
  await page.waitForSelector('.tabs', { timeout: 6000 });

  await page.click('[data-tab="auctions"]');
  await expect(page.locator('#tab-auctions')).toHaveClass(/active/);
  await expect(page.locator('#auctions-status')).not.toContainText('Loading', { timeout: 8000 });
  // Auction chips should be rendered
  await expect(page.locator('#auction-chips')).toBeVisible();
});

test('browser: clicking Diagnostics tab renders content', async ({ page }) => {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), adminToken);
  await page.goto(`${BASE}/admin/moderation.html`);
  await page.waitForSelector('.tabs', { timeout: 6000 });

  await page.click('[data-tab="diag"]');
  await expect(page.locator('#tab-diag')).toHaveClass(/active/);
  await expect(page.locator('#diag-status')).not.toContainText('Loading', { timeout: 8000 });
  await expect(page.locator('#diag-content')).not.toBeEmpty();
});

test('browser: seller search in Sellers tab works', async ({ page }) => {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), adminToken);
  await page.goto(`${BASE}/admin/moderation.html`);
  await page.waitForSelector('.tabs', { timeout: 6000 });

  await page.click('[data-tab="sellers"]');
  await page.waitForSelector('#seller-search', { timeout: 6000 });
  await page.fill('#seller-search', 'demo-seller');
  await page.click('.search-form button[type="submit"]');
  await expect(page.locator('#sellers-list')).not.toContainText('Loading', { timeout: 8000 });
  await expect(page.locator('#sellers-list')).toContainText('demo-seller', { timeout: 6000 });
});

test('browser: mobile viewport — no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(t => localStorage.setItem('token', t), adminToken);
  await page.goto(`${BASE}/admin/moderation.html`);
  await page.waitForSelector('h1', { timeout: 6000 });

  const scrollWidth  = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth  = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth, `Horizontal overflow: scrollWidth(${scrollWidth}) > clientWidth(${clientWidth})`).toBeLessThanOrEqual(clientWidth + 2);
});

// ── 21. Cleanup ───────────────────────────────────────────────────────────────

test('cleanup: delete testVideoId via admin', async ({ request }) => {
  if (!testVideoId) return;
  const res = await request.delete(
    `/api/auctions/${DEMO_AUCTION_ID}/walkthrough-video/${testVideoId}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  expect([200, 404]).toContain(res.status()); // 404 acceptable if already gone
});

test('cleanup: delete video2Id via admin', async ({ request }) => {
  if (!video2Id) return;
  const res = await request.delete(
    `/api/auctions/${DEMO_AUCTION_ID}/walkthrough-video/${video2Id}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  expect([200, 404]).toContain(res.status());
});
