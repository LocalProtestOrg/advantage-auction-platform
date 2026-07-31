'use strict';

// GET /api/auth/session-status — the minimal cross-origin session probe that lets the BD public
// header (www.advantage.bid) reflect a live Railway session as "Dashboard" instead of "Login".
// Contract: reads ONLY the aap_session cookie, returns ONLY a boolean, leaks no identity, and
// grants credentialed CORS ONLY to the approved Advantage.Bid hosts.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-session-status';

const jwt = require('jsonwebtoken');
const { COOKIE_NAME } = require('../src/lib/sessionCookie');
const router = require('../src/routes/auth');

// Pull the real handler out of the mounted router (no Express/supertest, no DB needed).
function getHandler(method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods && l.route.methods[method]);
  if (!layer) throw new Error('route not found: ' + method + ' ' + path);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const handler = getHandler('get', '/session-status');

function call({ cookie, origin } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const req = { headers };
  const res = {
    headers: {},
    _cache: null,
    header(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    set(k, v) { if (k.toLowerCase() === 'cache-control') this._cache = v; this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this._status = c; return this; },
    _body: null,
    json(b) { this._body = b; return this; },
  };
  const out = handler(req, res, () => {});
  return Promise.resolve(out).then(() => res);
}

const validCookie = () =>
  COOKIE_NAME + '=' + jwt.sign({ id: 'u-1', role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '1h' });

describe('GET /api/auth/session-status — authentication signal', () => {
  test('no cookie → { authenticated: false }', async () => {
    const res = await call({ origin: 'https://www.advantage.bid' });
    expect(res._body).toEqual({ authenticated: false });
  });

  test('valid session cookie → { authenticated: true }', async () => {
    const res = await call({ cookie: validCookie(), origin: 'https://www.advantage.bid' });
    expect(res._body).toEqual({ authenticated: true });
  });

  test('tampered/garbage cookie → false (fails safe, never throws)', async () => {
    const res = await call({ cookie: COOKIE_NAME + '=not.a.jwt', origin: 'https://www.advantage.bid' });
    expect(res._body).toEqual({ authenticated: false });
  });

  test('expired token → false', async () => {
    const expired = COOKIE_NAME + '=' + jwt.sign({ id: 'u-1', role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: -10 });
    const res = await call({ cookie: expired, origin: 'https://www.advantage.bid' });
    expect(res._body).toEqual({ authenticated: false });
  });

  test('a JWT signed with the WRONG secret → false', async () => {
    const forged = COOKIE_NAME + '=' + jwt.sign({ id: 'u-1', role: 'admin' }, 'a-different-secret', { expiresIn: '1h' });
    const res = await call({ cookie: forged, origin: 'https://www.advantage.bid' });
    expect(res._body).toEqual({ authenticated: false });
  });
});

describe('response leaks nothing beyond the boolean', () => {
  test('body has exactly one key: authenticated', async () => {
    const res = await call({ cookie: validCookie(), origin: 'https://www.advantage.bid' });
    expect(Object.keys(res._body)).toEqual(['authenticated']);
    const s = JSON.stringify(res._body);
    ['u-1', 'buyer', 'role', 'email', 'token', 'jwt', 'id'].forEach((leak) => expect(s).not.toContain(leak));
  });
  test('always no-store', async () => {
    const res = await call({ cookie: validCookie(), origin: 'https://www.advantage.bid' });
    expect(res._cache).toMatch(/no-store/);
  });
});

describe('credentialed CORS is restricted to approved Advantage.Bid hosts', () => {
  test('www.advantage.bid → exact ACAO + credentials true + Vary Origin', async () => {
    const res = await call({ origin: 'https://www.advantage.bid' });
    expect(res.headers['access-control-allow-origin']).toBe('https://www.advantage.bid');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['vary']).toBe('Origin');
  });
  test('apex advantage.bid is also approved', async () => {
    const res = await call({ origin: 'https://advantage.bid' });
    expect(res.headers['access-control-allow-origin']).toBe('https://advantage.bid');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
  test('a foreign origin gets NO ACAO and NO credentials header (cannot read credentialed)', async () => {
    const res = await call({ cookie: validCookie(), origin: 'https://evil.example' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    // still returns the boolean (the browser will simply block the cross-origin read)
    expect(res._body).toEqual({ authenticated: true });
  });
  test('ACAO is never the wildcard (incompatible with credentials)', async () => {
    const res = await call({ origin: 'https://www.advantage.bid' });
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});
