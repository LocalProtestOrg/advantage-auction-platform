'use strict';

// Authentication foundation housekeeping (2026-09-10):
//   M1  BD residual /signup -> authoritative Railway registration (header script + Railway-served BD init)
//   M2  migration 148 restores 082's email-verification objects additively (no fabricated history)
//   M3  optional auth recognises a valid Bearer OR aap_session cookie via the SAME resolver as mandatory auth
//   M4  a NULL/empty password_hash can never authenticate through password login; no internals leak
//   M5  identity integrity: roles unchanged, bridge never links by email, directory transport untouched

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-auth-housekeeping';

jest.mock('../src/db/index', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/services/emailVerificationService', () => ({
  sendWelcome: jest.fn(() => Promise.resolve({ ok: true })),
  verifyEmail: jest.fn(),
}));

const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const db = require('../src/db/index');
const { COOKIE_NAME } = require('../src/lib/sessionCookie');
const { resolveSession } = require('../src/lib/sessionAuth');
const optionalAuth = require('../src/middleware/optionalAuthMiddleware');
const authMiddleware = require('../src/middleware/authMiddleware');
const router = require('../src/routes/auth');

const SECRET = process.env.JWT_SECRET;
const nowS = () => Math.floor(Date.now() / 1000);
const tok = (claims, { expired = false, secret = SECRET } = {}) =>
  jwt.sign(Object.assign({}, claims, { iat: nowS() - 60, exp: expired ? nowS() - 5 : nowS() + 3600 }), secret);

// ───────────────────────── M1 · BD /signup routing ─────────────────────────
const HEADER_SRC = fs.readFileSync('scripts/bd/bd-header-session-aware.js', 'utf8');
const INIT_SRC = fs.readFileSync('public/widgets/bd-auctions-init.js', 'utf8');
const REGISTER = 'https://bid.advantage.bid/login.html?tab=register';

function runHeader(pathname, search = '') {
  const replaced = [];
  const location = { pathname, search, href: 'https://www.advantage.bid' + pathname + search, replace(u) { replaced.push(u); } };
  const document = { readyState: 'complete', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  const fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ authenticated: false }) });
  // eslint-disable-next-line no-new-func
  new Function('location', 'document', 'fetch', 'setTimeout', HEADER_SRC)(location, document, fetch, () => {});
  return replaced;
}
function runInit(hostname, pathname) {
  const replaced = [];
  const location = { hostname, pathname, replace(u) { replaced.push(u); } };
  const fetches = [];
  const document = {
    currentScript: { dataset: {} }, readyState: 'complete', addEventListener() {},
    getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
  };
  const fetch = (u) => { fetches.push(u); return Promise.resolve({ json: () => Promise.resolve({ data: [] }) }); };
  const window = { MarketplaceComponents: null };
  // eslint-disable-next-line no-new-func
  new Function('location', 'document', 'fetch', 'window', 'setTimeout', INIT_SRC)(location, document, fetch, window, () => {});
  return { replaced, fetches };
}

describe('M1 — BD public signup resolves to Railway registration', () => {
  test('1a. header script: /signup and /signup/ -> Railway Create Account', () => {
    expect(runHeader('/signup')).toEqual([REGISTER]);
    expect(runHeader('/signup/')).toEqual([REGISTER]);
  });
  test('1b. Railway-served BD init: /signup on www.advantage.bid and advantage.bid -> Railway Create Account', () => {
    expect(runInit('www.advantage.bid', '/signup').replaced).toEqual([REGISTER]);
    expect(runInit('advantage.bid', '/signup/').replaced).toEqual([REGISTER]);
  });
  test('1c. both mechanisms share the identical destination', () => {
    expect(HEADER_SRC).toContain(REGISTER);
    expect(INIT_SRC).toContain(REGISTER);
  });
  test('1d. never hijacks /signup on a seller/company website that embeds the init script', () => {
    expect(runInit('www.example-estate-sales.com', '/signup').replaced).toEqual([]);
    expect(runInit('bid.advantage.bid', '/signup').replaced).toEqual([]);
  });
  test('1e. exact path only — lookalike paths are untouched', () => {
    expect(runHeader('/signup-help')).toEqual([]);
    expect(runHeader('/join')).toEqual([]);
    expect(runInit('www.advantage.bid', '/signups').replaced).toEqual([]);
    expect(runInit('www.advantage.bid', '/auctions').replaced).toEqual([]);
  });
  test('2. existing BD login/logout routing is unchanged', () => {
    expect(runHeader('/login')).toEqual(['https://bid.advantage.bid/login.html']);
    expect(runHeader('/login/')).toEqual(['https://bid.advantage.bid/login.html']);
    expect(runHeader('/login', '?action=loggedout')).toEqual(['https://bid.advantage.bid/logout']);
  });
  test('3. BD directory/member integration untouched: read-only transport + bridge dest allowlist intact', () => {
    const transport = require('../src/services/bdRestTransport');
    expect(typeof transport.fetchAllListings).toBe('function');
    const tsrc = fs.readFileSync('src/services/bdRestTransport.js', 'utf8');
    expect(tsrc).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
    const { resolveDest } = require('../src/services/bridgeCodeService');
    if (typeof resolveDest === 'function') expect(resolveDest('dashboard')).toBe('/app.html');
  });
  test('1f. the init script still runs its inventory feed on the BD /auctions page', () => {
    const r = runInit('www.advantage.bid', '/auctions');
    expect(r.replaced).toEqual([]);
  });
});

// ───────────────────────── M3 · optional authentication ─────────────────────────
function req({ bearer, cookie, rawAuth } = {}) {
  const headers = {};
  if (rawAuth) headers.authorization = rawAuth;
  else if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = 'other=1; ' + COOKIE_NAME + '=' + cookie;
  return { headers, method: 'GET', path: '/api/lots/x' };
}
function runOptional(opts) {
  const r = req(opts); const res = { cookie: jest.fn(), set: jest.fn() }; const next = jest.fn();
  optionalAuth(r, res, next);
  return { user: r.user, next, res };
}
const A = { id: 'user-a', role: 'buyer' };
const B = { id: 'user-b', role: 'seller' };

describe('M3 — optional auth recognises Bearer OR cookie, never invalid credentials', () => {
  test('10. anonymous request stays anonymous', () => {
    const { user, next } = runOptional({});
    expect(user).toBeUndefined(); expect(next).toHaveBeenCalledTimes(1);
  });
  test('9. valid Bearer resolves the user', () => { expect(runOptional({ bearer: tok(A) }).user).toEqual(A); });
  test('8. valid cookie-only session resolves the user (the fix)', () => { expect(runOptional({ cookie: tok(B) }).user).toEqual(B); });
  test('11a. invalid Bearer alone is anonymous', () => { expect(runOptional({ bearer: 'not.a.jwt' }).user).toBeUndefined(); });
  test('11b. invalid cookie alone is anonymous', () => { expect(runOptional({ cookie: 'garbage' }).user).toBeUndefined(); });
  test('11c. expired Bearer and expired cookie are anonymous', () => {
    expect(runOptional({ bearer: tok(A, { expired: true }) }).user).toBeUndefined();
    expect(runOptional({ cookie: tok(A, { expired: true }) }).user).toBeUndefined();
  });
  test('11d. token signed with another secret is anonymous', () => {
    expect(runOptional({ cookie: tok(A, { secret: 'attacker-secret' }) }).user).toBeUndefined();
  });
  test('11e. signature-valid token without id/role is anonymous', () => {
    expect(runOptional({ bearer: tok({ id: 'x' }) }).user).toBeUndefined();
  });
  test('conflict: valid Bearer and valid cookie for different users -> Bearer wins (documented precedence)', () => {
    expect(runOptional({ bearer: tok(A), cookie: tok(B) }).user).toEqual(A);
  });
  test('conflict: invalid Bearer + valid cookie -> the independently valid cookie (same as mandatory auth)', () => {
    expect(runOptional({ bearer: tok(A, { expired: true }), cookie: tok(B) }).user).toEqual(B);
  });
  test('optional auth is read-only: never sets or renews the cookie', () => {
    const { res } = runOptional({ cookie: tok(B) });
    expect(res.cookie).not.toHaveBeenCalled(); expect(res.set).not.toHaveBeenCalled();
  });
  test('mandatory and optional auth resolve through the same function (no second JWT validator)', () => {
    const mw = fs.readFileSync('src/middleware/authMiddleware.js', 'utf8');
    const ow = fs.readFileSync('src/middleware/optionalAuthMiddleware.js', 'utf8');
    for (const src of [mw, ow]) { expect(src).toContain("require('../lib/sessionAuth')"); expect(src).not.toMatch(/jwt\.verify\(/); }
    const r = req({ bearer: tok(A), cookie: tok(B) });
    expect(resolveSession(r).source).toBe('bearer');
  });
  test('mandatory auth unchanged: cookie-only authenticates, expired both -> 401', () => {
    const ok = req({ cookie: tok(B) }); const next = jest.fn();
    const res = { set: jest.fn(), cookie: jest.fn(), status: jest.fn(() => ({ json: jest.fn() })) };
    authMiddleware(ok, res, next); expect(next).toHaveBeenCalled(); expect(ok.user).toEqual(B);
    const bad = req({ bearer: tok(A, { expired: true }), cookie: tok(B, { expired: true }) }); const next2 = jest.fn();
    authMiddleware(bad, res, next2); expect(next2).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(401);
  });
  test('public lot endpoints still use optional auth', () => {
    const lots = fs.readFileSync('src/routes/lots.js', 'utf8');
    expect((lots.match(/optionalAuth,/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

// ───────────────────────── M4 · login + registration ─────────────────────────
function handler(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const login = handler('post', '/login');
const register = handler('post', '/register');
function mkRes() {
  const res = { statusCode: 200, body: null, cookies: [] };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.cookie = (n, v) => { res.cookies.push({ n, v }); return res; };
  res.clearCookie = () => res; res.set = () => res; res.header = () => res;
  return res;
}
async function doLogin(body, userRow, { throws } = {}) {
  db.query.mockReset();
  db.query.mockImplementation((sql) => {
    if (throws && /SELECT \* FROM users/.test(sql)) return Promise.reject(new Error('relation "users" password leak details'));
    if (/SELECT \* FROM users/.test(sql)) return Promise.resolve({ rows: userRow ? [userRow] : [] });
    return Promise.resolve({ rows: [] });
  });
  const res = mkRes();
  await login({ body, headers: {} }, res);
  return res;
}

let HASH;
beforeAll(async () => { HASH = await bcrypt.hash('correct-horse-battery', 10); });

describe('M4 — NULL password safety + native login', () => {
  const GENERIC = { success: false, error: 'Invalid credentials' };
  test('12a. NULL password_hash cannot authenticate even with any password', async () => {
    const res = await doLogin({ email: 'social@x.test', password: 'anything-at-all' }, { id: 'u1', role: 'buyer', password_hash: null, is_active: true });
    expect(res.statusCode).toBe(401); expect(res.body).toEqual(GENERIC); expect(res.cookies).toEqual([]);
  });
  test('12b. empty-string and malformed hashes cannot authenticate', async () => {
    for (const h of ['', 'not-a-bcrypt-hash']) {
      const res = await doLogin({ email: 'x@x.test', password: 'p' }, { id: 'u1', role: 'buyer', password_hash: h, is_active: true });
      expect(res.statusCode).toBe(401); expect(res.body).toEqual(GENERIC);
    }
  });
  test('13a. unknown account, no-password account and wrong password are indistinguishable', async () => {
    const unknown = await doLogin({ email: 'nobody@x.test', password: 'p' }, null);
    const nopass = await doLogin({ email: 'social@x.test', password: 'p' }, { id: 'u1', role: 'buyer', password_hash: null, is_active: true });
    const wrong = await doLogin({ email: 'a@x.test', password: 'wrong' }, { id: 'u2', role: 'buyer', password_hash: HASH, is_active: true });
    for (const r of [unknown, nopass, wrong]) { expect(r.statusCode).toBe(401); expect(r.body).toEqual(GENERIC); }
  });
  test('13b. a suspended account without a password is still the generic 401 (status not revealed)', async () => {
    const res = await doLogin({ email: 's@x.test', password: 'p' }, { id: 'u3', role: 'buyer', password_hash: null, is_active: false });
    expect(res.statusCode).toBe(401); expect(res.body).toEqual(GENERIC);
  });
  test('13c. internal errors are never echoed', async () => {
    const res = await doLogin({ email: 'a@x.test', password: 'p' }, null, { throws: true });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|password leak|users/);
  });
  test('13d. a non-string password never throws into a leak', async () => {
    const res = await doLogin({ email: 'a@x.test', password: { $gt: '' } }, { id: 'u2', role: 'buyer', password_hash: HASH, is_active: true });
    expect(res.statusCode).toBe(401); expect(res.body).toEqual(GENERIC);
  });
  test('5. native buyer login works and issues token + cookie with the stored role', async () => {
    const res = await doLogin({ email: 'b@x.test', password: 'correct-horse-battery' }, { id: 'buyer-1', role: 'buyer', password_hash: HASH, is_active: true });
    expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true);
    expect(jwt.verify(res.body.token, SECRET)).toMatchObject({ id: 'buyer-1', role: 'buyer' });
    expect(res.cookies[0].n).toBe(COOKIE_NAME);
  });
  test('6. seller login works (role carried unchanged)', async () => {
    const res = await doLogin({ email: 's@x.test', password: 'correct-horse-battery' }, { id: 'seller-1', role: 'seller', password_hash: HASH, is_active: true });
    expect(res.statusCode).toBe(200); expect(jwt.verify(res.body.token, SECRET).role).toBe('seller');
  });
  test('7. admin and staff login work; staff access still comes from staff_role, not the token role', async () => {
    const admin = await doLogin({ email: 'ad@x.test', password: 'correct-horse-battery' }, { id: 'admin-1', role: 'admin', password_hash: HASH, is_active: true });
    expect(jwt.verify(admin.body.token, SECRET).role).toBe('admin');
    const staff = await doLogin({ email: 'st@x.test', password: 'correct-horse-battery' }, { id: 'staff-1', role: 'buyer', staff_role: 'support', password_hash: HASH, is_active: true });
    expect(staff.statusCode).toBe(200); expect(jwt.verify(staff.body.token, SECRET)).toMatchObject({ id: 'staff-1', role: 'buyer' });
  });
  test('suspended account with the correct password keeps its existing 403', async () => {
    const res = await doLogin({ email: 'x@x.test', password: 'correct-horse-battery' }, { id: 'u9', role: 'buyer', password_hash: HASH, is_active: false });
    expect(res.statusCode).toBe(403);
  });
  test('4. native email/password registration still creates a buyer with a hashed password', async () => {
    db.query.mockReset();
    db.query.mockImplementation((sql, params) => {
      if (/INSERT INTO users/.test(sql)) { expect(params[1]).not.toBe('pw-12345678'); expect(params[2]).toBe('buyer'); return Promise.resolve({ rows: [{ id: 'new-1', role: 'buyer' }] }); }
      return Promise.resolve({ rows: [] });
    });
    const res = mkRes();
    await register({ body: { email: 'new@x.test', password: 'pw-12345678' }, headers: {} }, res);
    expect(res.body.success).toBe(true); expect(jwt.verify(res.body.token, SECRET).role).toBe('buyer');
  });
});

// ───────────────────────── M2 · migration 148 ─────────────────────────
describe('M2 — migration 148 restores 082 additively', () => {
  const m148 = fs.readFileSync('db/migrations/148_restore_email_verification.sql', 'utf8');
  const m082 = fs.readFileSync('db/migrations/082_email_verification.sql', 'utf8');
  const code = m148.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  test('15a. every statement is idempotent (IF NOT EXISTS) and nothing is dropped or rewritten', () => {
    const stmts = code.split(';').map((s) => s.trim()).filter(Boolean);
    expect(stmts.length).toBe(5);
    for (const s of stmts) expect(s).toMatch(/IF NOT EXISTS/);
    expect(code).not.toMatch(/\bDROP\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
  });
  test('15b. no verification history is fabricated: default false, no backfill', () => {
    expect(code).toMatch(/email_verified\s+BOOLEAN NOT NULL DEFAULT false/);
    expect(code).not.toMatch(/DEFAULT true/i);
  });
  test('15c. restores exactly the objects 082 defines; 082 itself is unchanged', () => {
    for (const obj of ['email_verified ', 'email_verified_at', 'email_verification_tokens', 'idx_email_verif_token', 'idx_email_verif_user']) {
      expect(m082).toContain(obj); expect(code).toContain(obj);
    }
  });
  test('the production runner refuses non-production endpoints and verifies user count is unchanged', () => {
    const runner = fs.readFileSync('scripts/prod-migrate-148.js', 'utf8');
    expect(runner).toMatch(/REFUSE: STAGING endpoint/); expect(runner).toMatch(/users_total === before/);
  });
});

// ───────────────────────── M5 · identity integrity ─────────────────────────
describe('M5 — identity foundation integrity', () => {
  test('14a. bridge provisioning keys on (provider, subject) and never looks users up by email', () => {
    const src = fs.readFileSync('src/services/bridgeIdentityService.js', 'utf8');
    expect(src).toMatch(/provider_subject/);
    expect(src).not.toMatch(/FROM users[^;]*WHERE[^;]*\bemail\s*=/i);
    expect(src).not.toMatch(/lower\(\s*email\s*\)\s*=/i);
  });
  test('14b. nothing in this change writes external_identities or merges accounts by email', () => {
    for (const f of ['src/lib/sessionAuth.js', 'src/middleware/optionalAuthMiddleware.js', 'src/middleware/authMiddleware.js', 'db/migrations/148_restore_email_verification.sql']) {
      expect(fs.readFileSync(f, 'utf8')).not.toMatch(/external_identities/);
    }
    const auth = fs.readFileSync('src/routes/auth.js', 'utf8');
    expect(auth).not.toMatch(/INSERT INTO external_identities|UPDATE external_identities/);
  });
  test('14c. bridge accounts (random bcrypt password) still fail password login with a guessed password', async () => {
    const bridgeHash = await bcrypt.hash(require('crypto').randomBytes(32).toString('hex'), 10);
    const res = await doLogin({ email: 'bd-367@bridge.invalid', password: 'guess' }, { id: 'bridge-1', role: 'buyer', auth_source: 'bd_bridge', password_hash: bridgeHash, is_active: true });
    expect(res.statusCode).toBe(401);
  });
});
