'use strict';

/**
 * Regression tests for the 2026-10-15 marketplace security audit fixes (no database, no network):
 *   - sellers always create auctions in draft (no skipping review / 30-lot minimum / verification);
 *   - an Individual Seller with a submitted auction cannot self-upgrade to Professional (edit-lock bypass);
 *   - image-processing jobs only for the lot's / auction's own seller (or admin);
 *   - bid history and bid responses never carry account ids;
 *   - percent-encoded paths are gated like their decoded form;
 *   - registration accepts exactly one email address;
 *   - organization links are http(s) only;
 *   - user-controlled values are escaped in the admin dashboard, homepage map and invoice page;
 *   - post-login / post-action redirects are same-origin paths only.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/services/auctionService', () => ({ ...jest.requireActual('../src/services/auctionService'), createAuction: jest.fn(async (d) => ({ id: 'a-new', ...d })) }));
jest.mock('../src/services/agreementService', () => ({ ...jest.requireActual('../src/services/agreementService'), dashboardAccess: jest.fn(async () => ({ access: true })) }));
jest.mock('../src/services/imageProcessingService', () => ({ createProcessingJob: jest.fn(async (d) => ({ id: 'job-1', lot_temp_id: d.lotTempId || null })), getJobById: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

function handlerFor(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  const st = layer.route.stack; return st[st.length - 1].handle;
}
async function call(router, method, routePath, { params = {}, body = {}, user }) {
  let status = 200, out = null;
  const res = { set() { return res; }, status(c) { status = c; return res; }, json(b) { out = b; return res; }, end() { return res; } };
  await handlerFor(router, method, routePath)({ params, body, query: {}, headers: {}, user }, res, (e) => { if (e) throw e; });
  return { status, body: out };
}
beforeEach(() => { jest.clearAllMocks(); });

describe('auction creation', () => {
  const auctionService = require('../src/services/auctionService');
  const router = require('../src/routes/auctions');
  beforeEach(() => { db.query.mockImplementation(async (sql) => (/FROM seller_profiles WHERE id = \$1 AND user_id = \$2/.test(sql) ? { rows: [{ id: 'sp-1' }] } : { rows: [] })); });
  test('a seller asking for "active" or "published" still gets a draft', async () => {
    for (const state of ['active', 'published', 'closed']) {
      await call(router, 'post', '/', { body: { sellerProfileId: 'sp-1', title: 'X', state }, user: { id: 'u-1', role: 'seller' } });
      expect(auctionService.createAuction.mock.calls.pop()[0].state).toBe('draft');
    }
  });
  test('an admin may still create in another state', async () => {
    await call(router, 'post', '/', { body: { sellerProfileId: 'sp-1', title: 'X', state: 'published' }, user: { id: 'admin-1', role: 'admin' } });
    expect(auctionService.createAuction.mock.calls.pop()[0].state).toBe('published');
  });
});

describe('self-service Professional upgrade', () => {
  const router = require('../src/routes/sellers');
  const client = (pastDraft, type = 'private') => ({ release: jest.fn(), query: jest.fn(async (sql) => {
    if (/FROM users WHERE id/.test(sql)) return { rows: [{ id: 'u-1', role: 'seller', email: 'a@b.co' }] };
    if (/SELECT id FROM seller_profiles WHERE user_id/.test(sql)) return { rows: [{ id: 'sp-1' }] };
    if (/SELECT seller_type FROM seller_profiles WHERE id/.test(sql)) return { rows: [{ seller_type: type }] };
    if (/FROM auctions WHERE seller_id = \$1 AND state <> 'draft'/.test(sql)) return { rowCount: pastDraft ? 1 : 0, rows: pastDraft ? [{}] : [] };
    if (/^(BEGIN|ROLLBACK|COMMIT)$/.test(sql)) return { rows: [] };
    throw new Error('stop here (not part of this test): ' + String(sql).slice(0, 50));
  }) });
  const body = { seller_type: 'auction_house', company_name: 'X Co', phone: '5551234567' };
  test('an Individual Seller with a submitted auction is refused (409) and nothing is changed', async () => {
    const c = client(true); db.connect.mockResolvedValue(c);
    const r = await call(router, 'post', '/apply-professional', { body, user: { id: 'u-1', role: 'seller' } });
    expect(r.status).toBe(409); expect(r.body.code).toBe('CONTACT_ADVANTAGE');
    expect(c.query.mock.calls.some(([s]) => /UPDATE seller_profiles SET seller_type/.test(s))).toBe(false);
  });
  test('without a submitted auction the upgrade proceeds past the check', async () => {
    const c = client(false); db.connect.mockResolvedValue(c);
    await expect(call(router, 'post', '/apply-professional', { body, user: { id: 'u-1', role: 'seller' } })).rejects.toThrow(/stop here|UPDATE seller_profiles/);
  });
});

describe('image-processing jobs', () => {
  const router = require('../src/routes/imageProcessing');
  const ips = require('../src/services/imageProcessingService');
  test('a job for another seller\'s lot is refused; the owner and an admin may create it', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect((await call(router, 'post', '/jobs', { body: { lotTempId: 'victim-lot', originalImageUrl: 'u', enhancementType: 'auto_crop' }, user: { id: 'attacker', role: 'seller' } })).status).toBe(403);
    expect(ips.createProcessingJob).not.toHaveBeenCalled();
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect((await call(router, 'post', '/jobs', { body: { lotTempId: 'own-lot', originalImageUrl: 'u', enhancementType: 'auto_crop' }, user: { id: 'owner', role: 'seller' } })).status).toBe(201);
    expect((await call(router, 'post', '/jobs', { body: { lotTempId: 'any-lot', originalImageUrl: 'u', enhancementType: 'auto_crop' }, user: { id: 'a', role: 'admin' } })).status).toBe(201);
  });
  test('a job linked to another seller\'s lot is not readable', async () => {
    ips.getJobById.mockResolvedValue({ id: 'job-9', lot_temp_id: 'victim-lot' });
    db.query.mockResolvedValueOnce({ rows: [] });
    expect((await call(router, 'get', '/jobs/:id', { params: { id: 'job-9' }, user: { id: 'attacker', role: 'seller' } })).status).toBe(404);
  });
  test('buyers cannot use the endpoint at all', () => {
    const layer = router.stack.find((l) => l.route && l.route.path === '/jobs' && l.route.methods.post);
    expect(layer.route.stack.length).toBe(3);   // auth, role(['seller','admin']), handler
  });
});

describe('bid data never carries account ids', () => {
  test('bid history maps rows to amount/time/is_mine only', () => {
    const src = read('src', 'routes', 'lots.js');
    expect(src).toMatch(/const publicBid = \(b, viewerId\) => \(\{ id: b\.id, amount_cents: b\.amount_cents, amount: b\.amount, is_proxy: !!b\.is_proxy, created_at: b\.created_at,/);
    expect(src).toMatch(/data: bids\.map\(\(b\) => publicBid\(b, req\.user\.id\)\)/);
    expect(src).toMatch(/const \{ bidder_user_id: _b, winner_user_id: winnerId, prev_winner_user_id: _p, \.\.\.rest \} = result \|\| \{\};/);
    expect(src).toMatch(/viewer_is_high_bidder: winnerId === req\.user\.id/);
  });
});

describe('private page gate decodes paths', () => {
  const gate = require('../src/middleware/htmlAuthGate');
  const run = async (p) => { let st = 0, loc = null, nexted = false;
    const res = { set() { return res; }, status(c) { st = c; return res; }, end() { return res; }, redirect(c, l) { st = c; loc = l; return res; } };
    await gate({ method: 'GET', path: p, originalUrl: p, headers: {}, cookies: {} }, res, () => { nexted = true; });
    return { st, loc, nexted }; };
  test('/%61dmin/staff.html is gated like /admin/staff.html (not served to a signed-out visitor)', async () => {
    for (const p of ['/admin/staff.html', '/%61dmin/staff.html', '/admin/../admin/staff.html']) {
      const r = await run(p); expect(r.nexted).toBe(false); expect([302, 401, 403]).toContain(r.st);
    }
  });
  test('an undecodable path is refused, a public page passes', async () => {
    expect((await run('/%E0%A4%A.html')).st).toBe(400);
    expect((await run('/index.html')).nexted).toBe(true);
  });
});

describe('registration takes one email address', () => {
  test('lists and malformed addresses are refused before anything is stored or sent', async () => {
    const router = require('../src/routes/auth');
    for (const email of ['a@x.com, victim@y.com', 'a@x.com;b@y.com', 'Name <a@x.com>', 'no-at-sign', ['a@x.com'], 'x'.repeat(250) + '@y.com']) {
      const r = await call(router, 'post', '/register', { body: { email, password: 'longenough1' } });
      expect(r.status).toBe(400);
    }
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('organization links are http(s) only', () => {
  test('javascript: and data: URLs are refused on profile update', async () => {
    const orgs = require('../src/services/organizationsService');
    for (const u of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'JaVaScRiPt:x']) {
      await expect(orgs.updateProfile('u-1', 'o-1', { website_url: u })).rejects.toMatchObject({ code: 'INVALID_URL' });
    }
  });
});

describe('escaping and redirects in pages', () => {
  test('admin dashboard, homepage map/cards and invoice page escape user-controlled text', () => {
    const admin = read('public', 'admin', 'index.html');
    expect(admin).toMatch(/html \+= '<tr><td>' \+ escH\(r\.title \|\| '\(untitled\)'\) \+/);
    expect(admin).toMatch(/escH\(err && err\.message \? err\.message : 'Fetch failed'\)/);
    const home = read('public', 'index.html');
    expect(home.match(/'\+mpEsc\(d\.t\)\+'/g).length).toBe(3);
    expect(home).not.toMatch(/'\+d\.t\+'/);
    expect(read('public', 'dashboard', 'invoice.html')).toMatch(/escH\(inv\.auction_title\)/);
  });
  test('redirect targets go through the same-origin helper on every page', () => {
    const helper = /function safeInternalNext\(raw, fallback\) \{ try \{ if \(!raw \|\| !\/\^\\\/\(\?!\\\/\)\[\^\\s\]\*\$\/\.test\(raw\)\) return fallback; var u = new URL\(raw, location\.origin\); return u\.origin === location\.origin/;
    for (const f of ['add-card.html', 'login.html', 'verify-phone.html', 'sign-agreement.html']) expect(read('public', f)).toMatch(helper);
    global.location = { origin: 'https://bid.advantage.bid' };
    const fnSrc = read('public', 'login.html').match(/function safeInternalNext\(raw, fallback\) \{ try \{.*?catch \(e\) \{ return fallback; \} \}/)[0];
    // eslint-disable-next-line no-new-func
    const safe = new Function(fnSrc + '; return safeInternalNext;')();
    for (const bad of ['javascript:alert(1)', '//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com']) expect(safe(bad, 'F')).toBe('F');
    expect(safe('/app.html?x=1#y', 'F')).toBe('/app.html?x=1#y');
  });
});
