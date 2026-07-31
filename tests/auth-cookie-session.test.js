'use strict';

// The "Session Expired while the cookie is valid" fix: authMiddleware must accept the aap_session
// cookie as a fallback identity carrier (canonical browser session) when the Bearer token is absent
// or stale — while keeping Bearer primary and never weakening the cookie. Also verifies the client
// shell no longer declares the session dead solely because localStorage has no token.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cookie-session';

const jwt = require('jsonwebtoken');
const fs = require('fs');
const authMiddleware = require('../src/middleware/authMiddleware');
const { COOKIE_NAME } = require('../src/lib/sessionCookie');

const SECRET = process.env.JWT_SECRET;
const now = () => Math.floor(Date.now() / 1000);
const sign = (claims, iat, exp) => jwt.sign(Object.assign({}, claims, iat ? { iat } : {}, exp ? { exp } : {}), SECRET);

function makeReq({ bearer, cookie } = {}) {
  const headers = {};
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = COOKIE_NAME + '=' + cookie;
  return { headers, method: 'GET', path: '/api/auth/me' };
}
function makeRes() {
  const res = { headers: {}, cookies: [], statusCode: null, body: null };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.cookie = (n, v) => { res.cookies.push({ n, v }); return res; };
  res.status = (c) => { res.statusCode = c; return { json: (b) => { res.body = b; return res; } }; };
  return res;
}
function run(reqOpts) {
  const req = makeReq(reqOpts), res = makeRes(), next = jest.fn();
  authMiddleware(req, res, next);
  return { req, res, next, authed: next.mock.calls.length === 1 };
}

const validClaims = { id: 'u-1', role: 'buyer' };
const validToken = () => sign(validClaims, now() - 60, now() + 86340);
const expiredToken = () => sign(validClaims, now() - 100, now() - 10);

describe('authMiddleware — cookie is a valid fallback session (the fix)', () => {
  test('1. valid Bearer → authenticates (primary path, unchanged)', () => {
    const { res, next, req, authed } = run({ bearer: validToken() });
    expect(authed).toBe(true);
    expect(req.user).toEqual(validClaims);
    expect(res.statusCode).toBeNull();
  });

  test('2. NO Bearer + valid cookie → authenticates via cookie', () => {
    const { req, authed } = run({ cookie: validToken() });
    expect(authed).toBe(true);
    expect(req.user).toEqual(validClaims);
  });

  test('3. stale/expired Bearer + valid cookie → cookie wins (no false 401)', () => {
    const { req, res, authed } = run({ bearer: expiredToken(), cookie: validToken() });
    expect(authed).toBe(true);
    expect(req.user).toEqual(validClaims);
    expect(res.statusCode).toBeNull();
  });

  test('4. expired cookie + stale Bearer → 401 (logged out safely)', () => {
    const { res, next } = run({ bearer: expiredToken(), cookie: expiredToken() });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Session expired/);
  });

  test('5. no credentials at all → 401 Authentication required', () => {
    const { res } = run({});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  test('6. cookie auth refreshes the session cookie but does NOT leak a new JWT via X-Refreshed-Token', () => {
    // cookie token past half-life → cookie is re-issued (slides) but no header handed to JS.
    const { res, authed } = run({ cookie: sign(validClaims, now() - 5000, now() + 3000) });
    expect(authed).toBe(true);
    expect(res.cookies.length).toBe(1);                       // cookie refreshed
    expect(res.headers['X-Refreshed-Token']).toBeUndefined(); // not exposed to JS for cookie sessions
  });

  test('7. Bearer past half-life still emits X-Refreshed-Token (compat unchanged)', () => {
    const { res } = run({ bearer: sign(validClaims, now() - 5000, now() + 3000) });
    expect(res.headers['X-Refreshed-Token']).toBeTruthy();
    expect(jwt.verify(res.headers['X-Refreshed-Token'], SECRET).id).toBe('u-1');
  });

  test('8. garbage cookie, no Bearer → 401 (fails safe)', () => {
    const { res, next } = run({ cookie: 'not-a-jwt' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('member-shell client — cookie session is honored at startup', () => {
  const src = fs.readFileSync('public/widgets/shared/member-shell.js', 'utf8');
  test('apiGet sends the cookie (credentials) and only adds Bearer when a token exists', () => {
    expect(src).toMatch(/credentials:\s*'same-origin'/);
    expect(src).toMatch(/if \(t\) headers\.Authorization = 'Bearer ' \+ t/);
    // the OLD apiGet signature (unconditional Bearer, no credentials) is gone:
    expect(src).not.toMatch(/fetch\(path, \{ headers: \{ Authorization: 'Bearer ' \+ token\(\) \} \}\)/);
  });
  test('boot() no longer bails on a missing localStorage token', () => {
    expect(src).not.toMatch(/if \(!token\(\)\) return renderLoggedOut\(\)/);
    // it now lets the API result decide (401 → sign-in / session-expired)
    expect(src).toMatch(/me\.status === 401\) return token\(\) \? renderUnauthorized\(\) : renderLoggedOut\(\)/);
  });
});
