import 'dotenv/config';
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const BASE   = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN  = { email: 'test-admin@example.com', password: 'rehearsal123' };
const BUYER_A = { email: 'rehearsal-buyer-a@test.com', password: 'rehearsal123' };

async function apiLogin(request, creds) {
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}`).toBe(200);
  return body.token;
}

// ── Health endpoint ───────────────────────────────────────────────────────────

test('GET /api/health returns 200 with expected fields', async ({ request }) => {
  const res  = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = await res.json();

  expect(body.status).toBe('ok');
  expect(body).toHaveProperty('env');
  expect(body).toHaveProperty('uptime_seconds');
  expect(body).toHaveProperty('started_at');
  expect(body.db_reachable).toBe(true);
  expect(body).toHaveProperty('stripe_configured');
  expect(body).toHaveProperty('stripe_mode');
  expect(body).toHaveProperty('email_configured');
});

test('GET /api/health: stripe_mode is "test" in test environment', async ({ request }) => {
  const res  = await request.get('/api/health');
  const body = await res.json();
  expect(body.stripe_mode).toBe('test');
});

test('GET /api/health: stripe_configured is true (keys present)', async ({ request }) => {
  const res  = await request.get('/api/health');
  const body = await res.json();
  expect(body.stripe_configured).toBe(true);
});

test('GET /api/health: uptime_seconds is a positive integer', async ({ request }) => {
  const res  = await request.get('/api/health');
  const body = await res.json();
  expect(typeof body.uptime_seconds).toBe('number');
  expect(body.uptime_seconds).toBeGreaterThan(0);
});

test('GET /api/health: no auth required (public endpoint)', async ({ request }) => {
  // Call without any Authorization header
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
});

// ── Admin diagnostics: auctions ───────────────────────────────────────────────

test('GET /api/admin/diagnostics/auctions requires admin auth', async ({ request }) => {
  const res = await request.get('/api/admin/diagnostics/auctions');
  expect(res.status()).toBe(401);
});

test('GET /api/admin/diagnostics/auctions: non-admin buyer gets 403', async ({ request }) => {
  const token = await apiLogin(request, BUYER_A);
  const res = await request.get('/api/admin/diagnostics/auctions', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(403);
});

test('GET /api/admin/diagnostics/auctions: admin gets structured data', async ({ request }) => {
  const token = await apiLogin(request, ADMIN);
  const res   = await request.get('/api/admin/diagnostics/auctions', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data.auction_states)).toBe(true);
  expect(typeof body.data.open_lots).toBe('number');
  expect(Array.isArray(body.data.recent_auctions)).toBe(true);
});

// ── Admin diagnostics: payments ───────────────────────────────────────────────

test('GET /api/admin/diagnostics/payments requires admin auth', async ({ request }) => {
  const res = await request.get('/api/admin/diagnostics/payments');
  expect(res.status()).toBe(401);
});

test('GET /api/admin/diagnostics/payments: admin gets structured data', async ({ request }) => {
  const token = await apiLogin(request, ADMIN);
  const res   = await request.get('/api/admin/diagnostics/payments', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data.by_status)).toBe(true);
  expect(Array.isArray(body.data.recent_payments)).toBe(true);
});

// ── Startup / config visibility ───────────────────────────────────────────────

test('GET /api/payments/config returns publishableKey (startup config visible)', async ({ request }) => {
  const res  = await request.get('/api/payments/config');
  const body = await res.json();
  expect(typeof body.publishableKey).toBe('string');
  expect(body.publishableKey.length).toBeGreaterThan(0);
});

// ── Graceful degradation: unknown routes ──────────────────────────────────────

test('unknown API route returns JSON 404 (not HTML)', async ({ request }) => {
  const res  = await request.get('/api/this-does-not-exist');
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toBeTruthy();
});

test('API 404 response is valid JSON (no HTML fallback)', async ({ request }) => {
  const res     = await request.get('/api/xyz/abc/def');
  const headers = res.headers();
  expect(headers['content-type']).toMatch(/application\/json/);
});
