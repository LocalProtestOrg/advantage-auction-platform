'use strict';

// Server-side HTML auth gate + session cookie. Locks private pages behind authentication at the
// server (before express.static), so direct URL entry can't bypass auth and public pages stay open.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const fs = require('fs');
const jwt = require('jsonwebtoken');
const gate = require('../src/middleware/htmlAuthGate');
const cookieLib = require('../src/lib/sessionCookie');
const { COOKIE_NAME, readSessionToken, setSessionCookie, clearSessionCookie } = cookieLib;

const tok = (role, over) => jwt.sign(Object.assign({ id: 'u1', role }, over || {}), process.env.JWT_SECRET, { expiresIn: '1h' });

function run(path, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const headers = {};
    if (opts.cookieRole) headers.cookie = COOKIE_NAME + '=' + tok(opts.cookieRole);
    if (opts.cookieRaw !== undefined) headers.cookie = opts.cookieRaw;
    const req = { method: opts.method || 'GET', path, originalUrl: opts.originalUrl || path, headers };
    const res = {
      _h: {}, _status: null, _redirect: null,
      set(k, v) { this._h[k] = v; return this; },
      redirect(code, url) { if (typeof code === 'string') { url = code; code = 302; } this._status = code; this._redirect = url; resolve({ res, nextCalled: false }); },
      status(c) { this._status = c; return this; },
    };
    gate(req, res, () => resolve({ res, nextCalled: true }));
  });
}

describe('requirement() classification', () => {
  test('public paths are not gated', () => {
    ['/index.html', '/events.html', '/auction-view.html', '/lot.html', '/event.html', '/login.html',
     '/faq.html', '/how-it-works.html', '/become-seller.html', '/admin/events-admin.js'].forEach((p) =>
      expect(gate.requirement(p)).toBeNull());
  });
  test('admin pages require admin', () => {
    expect(gate.requirement('/admin/imported-events.html')).toEqual(['admin']);
    expect(gate.requirement('/admin/settlement-review.html')).toEqual(['admin']);
    expect(gate.requirement('/admin')).toEqual(['admin']);
  });
  test('seller pages require seller|admin', () => {
    ['/dashboard/seller.html', '/seller-create.html', '/lot-builder.html', '/seller-settlements.html', '/payout-profile.html']
      .forEach((p) => expect(gate.requirement(p)).toEqual(['seller', 'admin']));
  });
  test('member pages require any authenticated role', () => {
    ['/app.html', '/invoices.html', '/my-bids.html', '/payment.html', '/verify-documents.html']
      .forEach((p) => expect(gate.requirement(p)).toEqual(['buyer', 'seller', 'admin']));
  });
});

describe('gate — unauthenticated', () => {
  test('protected page with no cookie → 302 to login with safe next', async () => {
    const r = await run('/app.html');
    expect(r.nextCalled).toBe(false);
    expect(r.res._status).toBe(302);
    expect(r.res._redirect).toBe('/login.html?next=' + encodeURIComponent('/app.html'));
    expect(r.res._h['Cache-Control']).toMatch(/no-store/);
  });
  test('admin page with no cookie → login redirect', async () => {
    const r = await run('/admin/imported-events.html');
    expect(r.res._redirect).toContain('/login.html?next=');
  });
  test('previously-unguarded payment.html is now gated', async () => {
    const r = await run('/payment.html');
    expect(r.nextCalled).toBe(false);
    expect(r.res._redirect).toContain('/login.html');
  });
  test('public page passes through untouched', async () => {
    const r = await run('/index.html');
    expect(r.nextCalled).toBe(true);
  });
  test('invalid/garbage cookie → login redirect', async () => {
    const r = await run('/app.html', { cookieRaw: COOKIE_NAME + '=not-a-jwt' });
    expect(r.res._redirect).toContain('/login.html');
  });
  test('expired token cookie → login redirect', async () => {
    const expired = jwt.sign({ id: 'u1', role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: -10 });
    const r = await run('/app.html', { cookieRaw: COOKIE_NAME + '=' + expired });
    expect(r.res._redirect).toContain('/login.html');
  });
});

describe('gate — authenticated role enforcement', () => {
  test('buyer may load a member page', async () => {
    expect((await run('/app.html', { cookieRole: 'buyer' })).nextCalled).toBe(true);
  });
  test('buyer hitting an admin page → redirected to /app.html (not the admin page)', async () => {
    const r = await run('/admin/imported-events.html', { cookieRole: 'buyer' });
    expect(r.nextCalled).toBe(false);
    expect(r.res._redirect).toBe('/app.html');
  });
  test('buyer hitting a seller page → redirected to /app.html', async () => {
    const r = await run('/dashboard/seller.html', { cookieRole: 'buyer' });
    expect(r.res._redirect).toBe('/app.html');
  });
  test('seller may load seller pages; admin may load anything', async () => {
    expect((await run('/dashboard/seller.html', { cookieRole: 'seller' })).nextCalled).toBe(true);
    expect((await run('/admin/imported-events.html', { cookieRole: 'admin' })).nextCalled).toBe(true);
    expect((await run('/dashboard/seller.html', { cookieRole: 'admin' })).nextCalled).toBe(true);
  });
  test('non-GET requests are not gated (APIs enforce their own auth)', async () => {
    expect((await run('/app.html', { method: 'POST' })).nextCalled).toBe(true);
  });
});

describe('safeNext open-redirect guard', () => {
  test('rejects protocol-relative + backslash tricks, keeps same-origin path', () => {
    expect(gate.safeNext('//evil.com')).toBe('/app.html');
    expect(gate.safeNext('/\\evil.com')).toBe('/app.html');
    expect(gate.safeNext('https://evil.com')).toBe('/app.html');
    expect(gate.safeNext('/admin/imported-events.html')).toBe('/admin/imported-events.html');
  });
});

describe('sessionCookie helper', () => {
  test('setSessionCookie sets HttpOnly, SameSite=Lax, path=/', () => {
    const calls = [];
    const res = { cookie: (name, val, opts) => calls.push({ name, val, opts }) };
    setSessionCookie(res, 'JWTVALUE');
    expect(calls[0].name).toBe(COOKIE_NAME);
    expect(calls[0].val).toBe('JWTVALUE');
    expect(calls[0].opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });
  test('clearSessionCookie clears the cookie', () => {
    const cleared = [];
    clearSessionCookie({ clearCookie: (n) => cleared.push(n) });
    expect(cleared).toContain(COOKIE_NAME);
  });
  test('readSessionToken parses the cookie header (no cookie-parser dep)', () => {
    expect(readSessionToken({ headers: { cookie: 'other=1; ' + COOKIE_NAME + '=ABC123; foo=bar' } })).toBe('ABC123');
    expect(readSessionToken({ headers: {} })).toBeNull();
    expect(readSessionToken({ headers: { cookie: 'other=1' } })).toBeNull();
  });
});

describe('wiring (source-level)', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const auth = fs.readFileSync('src/routes/auth.js', 'utf8');
  test('gate is mounted BEFORE express.static', () => {
    const gateIdx = server.indexOf("require('./src/middleware/htmlAuthGate')");
    const staticIdx = server.indexOf('express.static(path.join(__dirname');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(staticIdx).toBeGreaterThan(gateIdx);
  });
  test('central /logout route clears cookie + client token', () => {
    expect(server).toMatch(/app\.get\('\/logout'/);
    expect(server).toMatch(/clearSessionCookie/);
    expect(server).toMatch(/localStorage\.removeItem\("token"\)/);
  });
  test('login + register set the session cookie', () => {
    expect(auth).toMatch(/setSessionCookie\(res, token\)/);
    expect(auth).toMatch(/router\.post\('\/logout'/);
    expect(auth).toMatch(/router\.post\('\/session', auth/);
  });
});
