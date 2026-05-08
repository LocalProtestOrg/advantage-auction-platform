import 'dotenv/config';
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const BASE  = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = { email: 'test-admin@example.com', password: 'rehearsal123' };

async function apiLogin(request, creds) {
  const res  = await request.post('/api/auth/login', { data: creds });
  const body = await res.json();
  expect(res.status(), `Login failed for ${creds.email}`).toBe(200);
  return body.token;
}

// ── CORS ─────────────────────────────────────────────────────────────────────

test('OPTIONS preflight returns 200', async ({ request }) => {
  const res = await request.fetch('/api/health', { method: 'OPTIONS' });
  expect(res.status()).toBe(200);
});

test('API responses include Access-Control-Allow-Origin header', async ({ request }) => {
  const res     = await request.get('/api/health');
  const headers = res.headers();
  expect(headers['access-control-allow-origin']).toBeTruthy();
});

// ── Input validation ─────────────────────────────────────────────────────────

test('register without email returns 400', async ({ request }) => {
  const res = await request.post('/api/auth/register', {
    data: { password: 'somepassword' },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error || body.success === false).toBeTruthy();
});

test('login without password returns 400', async ({ request }) => {
  const res = await request.post('/api/auth/login', {
    data: { email: 'someone@example.com' },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error || body.success === false).toBeTruthy();
});

test('malformed JSON body returns 400 not 500', async ({ request }) => {
  const res = await request.fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data:    'not valid json{{{',
  });
  expect(res.status()).toBe(400);
});

// ── Auth token lifecycle ──────────────────────────────────────────────────────

test('valid login returns a JWT token', async ({ request }) => {
  const res  = await request.post('/api/auth/login', { data: ADMIN });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(typeof body.token).toBe('string');
  expect(body.token.length).toBeGreaterThan(20);
});

test('JWT token contains expected claims (id + role)', async ({ request }) => {
  const res  = await request.post('/api/auth/login', { data: ADMIN });
  const body = await res.json();

  // Decode payload without verifying signature — safe for claim inspection only
  const payloadB64 = body.token.split('.')[1];
  const payload    = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

  expect(typeof payload.id).toBe('string');
  expect(payload.role).toBe('admin');
  expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
});

test('wrong password returns 401 with JSON body', async ({ request }) => {
  const res  = await request.post('/api/auth/login', {
    data: { email: ADMIN.email, password: 'wrong-password' },
  });
  expect(res.status()).toBe(401);
  const body    = await res.json();
  const headers = res.headers();
  expect(headers['content-type']).toMatch(/application\/json/);
  expect(body.error || body.success === false).toBeTruthy();
});

// ── Admin diagnostics: notifications ─────────────────────────────────────────

test('GET /api/admin/diagnostics/notifications requires admin auth', async ({ request }) => {
  const res = await request.get('/api/admin/diagnostics/notifications');
  expect(res.status()).toBe(401);
});

test('GET /api/admin/diagnostics/notifications: admin gets structured data', async ({ request }) => {
  const token = await apiLogin(request, ADMIN);
  const res   = await request.get('/api/admin/diagnostics/notifications', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data.by_status)).toBe(true);
  expect(typeof body.data.queue_depth).toBe('number');
  expect(Array.isArray(body.data.recent_notifications)).toBe(true);
});

// ── Error response consistency ────────────────────────────────────────────────

test('all API 4xx responses have JSON content-type', async ({ request }) => {
  const [r1, r2, r3] = await Promise.all([
    request.get('/api/this-does-not-exist'),
    request.post('/api/auth/login', { data: { email: 'x@x.com' } }),
    request.get('/api/admin/diagnostics/auctions'),
  ]);

  for (const r of [r1, r2, r3]) {
    const ct = r.headers()['content-type'];
    expect(ct, `Expected JSON content-type, got: ${ct}`).toMatch(/application\/json/);
  }
});
