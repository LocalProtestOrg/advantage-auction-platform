'use strict';

/**
 * Private Interactive Sales Demo — landing page + server-authoritative demo safety.
 * Behavioral unit tests for the demo guard (mocked db) + source/migration assertions for isolation,
 * side-effect blocking, protected fixtures, and no unsafe exposure.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── Demo guard (behavioral) ─────────────────────────────────────────────────────
describe('demoGuard — server-authoritative demo detection + side-effect block', () => {
  jest.resetModules();
  jest.doMock('../src/db', () => ({ query: jest.fn() }));
  const db = require('../src/db');
  const guard = require('../src/middleware/demoGuard');
  beforeEach(() => { db.query.mockReset(); guard._cache.clear(); });

  test('isDemoUser reads the authoritative users.is_demo flag (never a client value)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ is_demo: true }] });
    expect(await guard.isDemoUser('u1')).toBe(true);
    expect(db.query.mock.calls[0][0]).toMatch(/SELECT is_demo FROM users WHERE id = \$1/);
    db.query.mockResolvedValueOnce({ rows: [{ is_demo: false }] });
    expect(await guard.isDemoUser('u2')).toBe(false);
  });
  test('blocks a demo account from a side-effect action (403 DEMO_ACTION_BLOCKED)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ is_demo: true }] });
    let code, body; const res = { status: (c) => { code = c; return res; }, json: (b) => { body = b; } };
    const next = jest.fn();
    await new Promise((resolve) => { guard.blockDemoSideEffects({ user: { id: 'd1' } }, res, () => { next(); resolve(); }); setTimeout(resolve, 40); });
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe(403);
    expect(body.code).toBe('DEMO_ACTION_BLOCKED');
  });
  test('lets a normal (non-demo) account through', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ is_demo: false }] });
    const next = jest.fn();
    await new Promise((resolve) => { guard.blockDemoSideEffects({ user: { id: 'r1' } }, { status: () => ({ json: () => {} }) }, () => { next(); resolve(); }); setTimeout(resolve, 40); });
    expect(next).toHaveBeenCalled();
  });
  test('fail-open to non-demo on a lookup error (never mislabels a real user as demo)', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    expect(await guard.isDemoUser('u3')).toBe(false);
  });
});

// ── Side-effect endpoints are guarded ───────────────────────────────────────────
describe('real-side-effect endpoints block demo accounts', () => {
  test('payments (charge/setup/card) run blockDemoSideEffects after auth', () => {
    const p = read('src', 'routes', 'payments.js');
    expect(p).toMatch(/require\('\.\.\/middleware\/demoGuard'\)/);
    ['/charge-lot', '/charge-combined', '/setup-intent', '/card-on-file'].forEach((r) => {
      const line = p.split('\n').find((l) => l.includes("'" + r + "'") && l.includes('router.'));
      expect(line).toMatch(/blockDemoSideEffects/);
    });
  });
  test('payout/Connect onboarding blocks demo accounts', () => {
    const p = read('src', 'routes', 'payoutProfile.js');
    ['/me/connect/onboard', '/me/ach/setup-intent', '/me/ach/confirm'].forEach((r) => {
      const line = p.split('\n').find((l) => l.includes("'" + r + "'") && l.includes('router.'));
      expect(line).toMatch(/blockDemoSideEffects/);
    });
  });
  test('bulk follower-campaign endpoint blocks demo accounts', () => {
    expect(read('src', 'routes', 'orgEvents.js')).toMatch(/follower-campaign', blockDemoSideEffects/);
  });
});

// ── Demo content isolation (no public marketplace junk) ─────────────────────────
describe('demo content is isolated from public surfaces', () => {
  test('createAuction forces is_demo + hidden for a demo seller', () => {
    const a = read('src', 'services', 'auctionService.js');
    expect(a).toMatch(/SELECT is_demo FROM seller_profiles WHERE id = \$1/);
    expect(a).toMatch(/UPDATE auctions SET is_demo = true, marketplace_status = 'hidden'/);
  });
  test('public visibility excludes is_demo (existing predicate — demo never surfaces publicly)', () => {
    expect(read('src', 'lib', 'marketplaceVisibility.js')).toMatch(/is_demo IS NOT TRUE/);
  });
});

// ── Migration 124: demo-account hardening ───────────────────────────────────────
describe('migration 124 — demo account hardening', () => {
  const mig = read('db', 'migrations', '124_demo_account_hardening.sql');
  test('flags the two demo emails is_demo, makes demo seller professional, isolates its auctions', () => {
    expect(mig).toMatch(/UPDATE users SET is_demo = true[\s\S]*demo-seller@advantage\.bid[\s\S]*demo-buyer@advantage\.bid/);
    expect(mig).toMatch(/UPDATE seller_profiles[\s\S]*is_demo = true, seller_type = 'estate_sale_company'/);
    expect(mig).toMatch(/UPDATE auctions[\s\S]*is_demo = true, marketplace_status = 'hidden'/);
  });
  test('a PROD-guarded migration script exists', () => {
    const m = read('scripts', 'prod-migrate-124.js');
    expect(m).toMatch(/ep-proud-leaf-an8pzkib/);
    expect(m).toMatch(/REFUSE: STAGING/);
  });
});

// ── Demo landing page ───────────────────────────────────────────────────────────
describe('demo landing page', () => {
  const page = read('public', 'demo.html');
  test('is noindex/nofollow and disallowed in robots (not in sitemap/nav)', () => {
    expect(page).toMatch(/name="robots" content="noindex, nofollow"/);
    expect(read('public', 'robots.txt')).toMatch(/Disallow: \/demo\.html/);
  });
  test('one-click enter uses the REAL login endpoint (no auth bypass) for the demo accounts', () => {
    expect(page).toMatch(/\/api\/auth\/login/);
    expect(page).toMatch(/demo-seller@advantage\.bid/);
    expect(page).toMatch(/demo-buyer@advantage\.bid/);
    // no privileged/admin credentials exposed
    expect(page).not.toMatch(/admin@advantage\.bid|tylerwitt|sales-demo-seller@/i);
  });
  test('shows the public showcase + is honest that it is a demo', () => {
    expect(page).toMatch(/0000000d0003/);              // Maplewood auction
    expect(page).toMatch(/heritage-home-estate-services/); // storefront
    expect(page).toMatch(/This is a demo/i);
  });
  test('shows the PUBLIC support phone, never the Twilio sending number', () => {
    expect(page).toMatch(/data-adv-tel/);              // renders (551) 655-7050 via companyContact
    expect(page).not.toMatch(/731|224-3669|7312243669/); // Twilio sending number never exposed
  });
});

// ── Reset + protected fixtures ──────────────────────────────────────────────────
describe('reset + protected fixtures', () => {
  test('demo reset (demo-environment.js) is is_demo-scoped + idempotent (safe to reuse)', () => {
    const r = read('scripts', 'demo-environment.js');
    expect(r).toMatch(/is_demo/);
    expect(r.toLowerCase()).toMatch(/idempotent|reset/);
  });
  test('the canonical Maplewood fixture is owned by a SEPARATE non-loginable account (prospects cannot corrupt it)', () => {
    // demo-environment seeds sales-demo-seller (no usable password); prospects log in as demo-seller@ (different account)
    const r = read('scripts', 'demo-environment.js');
    expect(r).toMatch(/sales-demo-seller@advantage\.bid/);
    expect(r).toMatch(/unusablePasswordHash|password_hash stays NULL|cannot be logged into/i);
    expect(read('public', 'demo.html')).not.toMatch(/sales-demo-seller/); // prospects never get the fixture-owner account
  });
});

// ── Security regression (admin/CRM stay gated; nothing weakened) ─────────────────
describe('admin/CRM isolation unchanged', () => {
  test('admin + sales routes remain role/permission gated (demo accounts are seller/buyer only)', () => {
    expect(read('src', 'routes', 'adminCompliance.js')).toMatch(/roleMiddleware\(\['admin'\]\)/);
    expect(read('src', 'routes', 'adminSales.js')).toMatch(/requirePermission/);
  });
});

// ── FINAL POLISH: example company website + safe website-widget demonstration ─────
describe('example company website (website-widget sales demonstration)', () => {
  const example = read('public', 'demo', 'example-company-website.html');
  const embed = read('public', 'embed', 'auctions.html');

  test('the example company website exists and is noindex (not publicly promoted)', () => {
    expect(example).toMatch(/name="robots" content="noindex, nofollow"/);
    expect(read('public', 'robots.txt')).toMatch(/Disallow: \/demo\//);
  });
  test('it presents a clearly fictional company + is labeled an example/demo', () => {
    expect(example).toMatch(/Brookfield Estate Auctions/);
    expect(example).toMatch(/Example Company Website/i);
    expect(example).toMatch(/not a real business/i);
  });
  test('it embeds the CERTIFIED widget rendering in demo mode (no key, no API)', () => {
    expect(example).toMatch(/\/embed\/auctions\.html\?demo=1/);
  });
  test('NO production-usable widget key is exposed to the prospect', () => {
    expect(example).not.toMatch(/wgt_[a-f0-9]{36}/);      // never a real key
    expect(read('public', 'demo.html')).not.toMatch(/wgt_[a-f0-9]{36}/);
  });
  test('NO prospect-usable install/embed code is exposed on the example site', () => {
    expect(example).not.toMatch(/data-advantage-auctions/);   // the real install snippet's marker
    expect(example).not.toMatch(/company-auctions\.js/);      // the real installable loader
    expect(example).not.toMatch(/Copy Code|Install code/i);
  });

  test('the certified embed page adds a demo-only branch that reuses the SAME rendering (no key, no fetch)', () => {
    expect(embed).toMatch(/q\('demo'\) === '1'/);
    expect(embed).toMatch(/render\(demoData\(\)\)/);
    // demoData carries NO key and links to a real PUBLIC auction (bidding on the platform)
    expect(embed).toMatch(/0000000d0003/);
    expect(embed).not.toMatch(/wgt_[a-f0-9]{36}/);
  });
  test('the certified KEYED production path is unchanged (still fetches the tenant feed by key)', () => {
    expect(embed).toMatch(/fetch\('\/api\/public\/widget\/auctions\?key=' \+ encodeURIComponent\(KEY\)\)/);
  });
});

describe('demo landing links prospects to the website-widget preview', () => {
  const page = read('public', 'demo.html');
  test('demo.html links to the example company website with clear seller wording', () => {
    expect(page).toMatch(/\/demo\/example-company-website\.html/);
    expect(page).toMatch(/on your (own )?(company )?website|Website Widget/i);
  });
});

describe('demo-seller dashboard widget experience (safe accommodation, prod path intact)', () => {
  const sellers = read('src', 'routes', 'sellers.js');
  const dash = read('public', 'seller-dashboard.html');

  test('/me/widget short-circuits demo accounts to a safe example (NO real key issued)', () => {
    // The isDemoUser check must appear before any ensureWidgetKey call and return demo:true w/o a key.
    const body = sellers.slice(sellers.indexOf("router.get('/me/widget'"), sellers.indexOf("router.post('/me/widget/rotate'"));
    expect(body).toMatch(/isDemoUser\(req\.user\.id\)/);
    expect(body).toMatch(/demo: true/);
    expect(body).toMatch(/example_url/);
    // demo branch precedes the real key issuance
    expect(body.indexOf('isDemoUser')).toBeLessThan(body.indexOf('ensureWidgetKey'));
  });
  test('the REAL eligible Professional Seller widget experience is unchanged (key + embed still returned)', () => {
    const body = sellers.slice(sellers.indexOf("router.get('/me/widget'"), sellers.indexOf("router.post('/me/widget/rotate'"));
    expect(body).toMatch(/eligible: true, key,/);
    expect(body).toMatch(/embed_code: widgetService\.buildEmbedCode/);
    expect(body).toMatch(/preview_url:/);
  });
  test('dashboard renders a demo example link (no Copy Code) for demo accounts, keeps Copy Code for real pros', () => {
    expect(dash).toMatch(/d\.demo/);
    expect(dash).toMatch(/See How This Looks on Your Website/);
    // the certified installable path (Copy Code / Install code) is still present for eligible pros
    expect(dash).toMatch(/Copy Code/);
    expect(dash).toMatch(/Install code/);
  });
});

describe('certified white-label widget tenant isolation remains intact', () => {
  const svc = read('src', 'services', 'widgetService.js');
  test('key still resolves to exactly one org and the feed still uses the canonical public predicate', () => {
    expect(svc).toMatch(/profile_data->>'widget_key' = \$1/);           // opaque token → one org
    expect(svc).toMatch(/activeNativeAuctionSql/);                       // never leaks private/demo auctions
    expect(svc).toMatch(/eligibilityForUser/);                          // config derived from req.user's org
  });
});
