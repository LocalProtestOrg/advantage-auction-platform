'use strict';

/**
 * Professional Seller white-label auction widget — security (tenant isolation is a RELEASE BLOCKER) +
 * functional tests. Unit tests (mocked db) for the service + framing; source-level assertions for the
 * routes, embed host, loader, and dashboard.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── Service: keys, resolution, eligibility, feed (mocked db) ────────────────────
describe('widgetService', () => {
  jest.resetModules();
  jest.doMock('../src/db', () => ({ query: jest.fn() }));
  const db = require('../src/db');
  const w = require('../src/services/widgetService');
  beforeEach(() => { db.query.mockReset(); });

  test('keys are opaque wgt_ tokens; shape validation rejects junk / injection', () => {
    const k = w.generateKey();
    expect(w.isValidKeyShape(k)).toBe(true);
    ['', 'abc', 'wgt_', 'wgt_xyz', 'wgt_' + 'a'.repeat(35), '../../etc', 'wgt_<script>', null].forEach((bad) => {
      expect(w.isValidKeyShape(bad)).toBe(false);
    });
  });
  test('resolveKeyToOrg rejects an invalid key WITHOUT touching the db (no probing surface)', async () => {
    const org = await w.resolveKeyToOrg('not-a-key');
    expect(org).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
  test('resolveKeyToOrg maps a valid key via profile_data->>widget_key (one tenant only)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'o1', name: 'Acme', linked_seller_profile_id: 'sp1' }] });
    const org = await w.resolveKeyToOrg('wgt_' + 'a'.repeat(36));
    expect(org.id).toBe('o1');
    expect(db.query.mock.calls[0][0]).toMatch(/profile_data->>'widget_key' = \$1/);
  });
  test('eligibility derives the org from the user\'s OWNED membership + requires a professional linked seller', async () => {
    // owner org
    db.query.mockResolvedValueOnce({ rows: [{ id: 'o1', name: 'Acme', slug: 'acme', linked_seller_profile_id: 'sp1', profile_data: {} }] });
    // the linked seller_profile, owned by the same user, professional type
    db.query.mockResolvedValueOnce({ rows: [{ id: 'sp1', seller_type: 'auction_house', user_id: 'u1' }] });
    const e = await w.eligibilityForUser('u1');
    expect(e.eligible).toBe(true);
    expect(e.sellerProfileId).toBe('sp1');
    // the org query is scoped by owner membership (never a client id)
    expect(db.query.mock.calls[0][0]).toMatch(/organization_members m .*role = 'owner' AND m\.status = 'active'/s);
  });
  test('eligibility rejects a non-professional or non-owned linked seller', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'o1', linked_seller_profile_id: 'sp1', profile_data: {} }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'sp1', seller_type: 'private', user_id: 'u1' }] });
    expect((await w.eligibilityForUser('u1')).eligible).toBe(false);
    db.query.mockResolvedValueOnce({ rows: [{ id: 'o1', linked_seller_profile_id: 'sp1', profile_data: {} }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'sp1', seller_type: 'auction_house', user_id: 'someone_else' }] });
    expect((await w.eligibilityForUser('u1')).eligible).toBe(false); // A can't ride B's seller_profile
  });
  test('ensureWidgetKey generates + persists only when missing (idempotent)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ profile_data: {} }] });   // read
    db.query.mockResolvedValueOnce({ rows: [] });                       // update
    const k1 = await w.ensureWidgetKey('o1');
    expect(w.isValidKeyShape(k1)).toBe(true);
    const existing = 'wgt_' + 'b'.repeat(36);
    db.query.mockResolvedValueOnce({ rows: [{ profile_data: { widget_key: existing } }] });
    const k2 = await w.ensureWidgetKey('o1');
    expect(k2).toBe(existing); // no regenerate
  });
  test('listPublicAuctions uses the canonical public-visibility gate + splits live/upcoming, links to bid.advantage.bid', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: 'a1', title: 'Live One', state: 'active', lot_count: 5, city: 'Newark', address_state: 'NJ' },
      { id: 'a2', title: 'Soon', state: 'published', lot_count: 2, city: 'Trenton', address_state: 'NJ' },
    ] });
    const r = await w.listPublicAuctions('sp1');
    expect(db.query.mock.calls[0][0]).toMatch(/a\.state IN \('published','active'\).*marketplace_status = 'syndicated'.*is_demo IS NOT TRUE/s);
    expect(r.current).toHaveLength(1);
    expect(r.upcoming).toHaveLength(1);
    expect(r.current[0].href).toMatch(/bid\.advantage\.bid\/auction-view\.html\?auctionId=a1/);
    // public-safe only: no seller PII fields
    expect(JSON.stringify(r)).not.toMatch(/email|phone|street|address_line/i);
  });
  test('buildEmbedCode is a public snippet (opaque token, no secret)', () => {
    const code = w.buildEmbedCode('wgt_' + 'c'.repeat(36), 'https://bid.advantage.bid');
    expect(code).toMatch(/data-advantage-auctions data-key="wgt_c{36}"/);
    expect(code).toMatch(/\/widgets\/company-auctions\.js/);
    expect(code).not.toMatch(/secret|api[_-]?key|token=|Authorization/i);
  });
});

// ── Framing: /embed/* embeddable anywhere; /widgets/* stays BD-only; others untouched ──
describe('widgetFraming (embed host is cross-origin frameable; nothing else weakened)', () => {
  const framing = require('../src/middleware/widgetFraming');
  function run(p) {
    const headers = {}; let removed = null;
    const res = { setHeader: (k, v) => { headers[k] = v; }, removeHeader: (k) => { removed = k; } };
    framing({ path: p }, res, () => {});
    return { headers, removed };
  }
  test('/embed/* drops X-Frame-Options and allows any parent origin (public data only)', () => {
    const r = run('/embed/auctions.html');
    expect(r.removed).toBe('X-Frame-Options');
    expect(r.headers['Content-Security-Policy']).toBe('frame-ancestors *');
  });
  test('/widgets/* keeps the narrow BD-only allowlist (unchanged)', () => {
    const r = run('/widgets/company-auctions.js');
    expect(r.headers['Content-Security-Policy']).toMatch(/frame-ancestors https:\/\/advantage\.bid https:\/\/www\.advantage\.bid/);
  });
  test('other routes are untouched (keep helmet SAMEORIGIN)', () => {
    const r = run('/admin/business-listings.html');
    expect(r.removed).toBeNull();
    expect(r.headers['Content-Security-Policy']).toBeUndefined();
  });
});

// ── Routes: public feed empty-on-unknown; seller config is owner-scoped ──────────
describe('routes', () => {
  const pub = read('src', 'routes', 'publicWidget.js');
  const sellers = read('src', 'routes', 'sellers.js');
  test('public feed returns EMPTY (not 404) for an unknown key — no existence probing', () => {
    expect(pub).toMatch(/resolveKeyToOrg\(String\(req\.query\.key/);
    expect(pub).toMatch(/if \(!org\).*current: \[\], upcoming: \[\]/s);
  });
  test('seller widget config derives the org from req.user (never a client-supplied id)', () => {
    expect(sellers).toMatch(/widgetService\.eligibilityForUser\(req\.user\.id\)/);
    expect(sellers).toMatch(/router\.get\('\/me\/widget', auth,/);
    expect(sellers).toMatch(/router\.post\('\/me\/widget\/rotate', auth,/);
    // config must never read an org/seller id from the request body/params
    const block = sellers.slice(sellers.indexOf("'/me/widget'"), sellers.indexOf('me/dashboard'));
    expect(block).not.toMatch(/req\.body\.(org|organization|seller)|req\.params\.(org|seller)/);
  });
  test('rotate is forbidden (403) for non-eligible callers', () => {
    expect(sellers).toMatch(/WIDGET_NOT_ELIGIBLE/);
  });
  test('mounted at /api/public/widget', () => {
    expect(read('server.js')).toMatch(/app\.use\('\/api\/public\/widget', require\('\.\/src\/routes\/publicWidget'\)\)/);
  });
});

// ── Embed host page: white-label, XSS-safe, links out, safe postMessage ──────────
describe('embed host page (/embed/auctions.html)', () => {
  const page = read('public', 'embed', 'auctions.html');
  test('is white-label — no Advantage.Bid logo/wordmark as the visual brand', () => {
    expect(page).not.toMatch(/Advantage<span|class="brand"|logo/i);
    expect(page).not.toMatch(/>Advantage\.Bid</);
  });
  test('escapes all dynamic content (XSS) and shows only public fields', () => {
    expect(page).toMatch(/function esc\(/);
    expect(page).toMatch(/esc\(a\.title/);
    expect(page).not.toMatch(/email|phone|contact_/i);
  });
  test('links open the auction on the identified bid.advantage.bid platform (target _top)', () => {
    expect(page).toMatch(/target="_top"/);
    expect(page).toMatch(/a\.href/);
  });
  test('only ever posts a numeric height to the parent (no data exfiltration)', () => {
    expect(page).toMatch(/type: 'adv-wl-height', height: h/);
  });
});

// ── Loader: strict postMessage validation, key-shape guard, no secrets ──────────
describe('loader (/widgets/company-auctions.js)', () => {
  const js = read('public', 'widgets', 'company-auctions.js');
  test('validates message origin AND exact iframe source AND numeric height', () => {
    expect(js).toMatch(/if \(e\.origin !== ORIGIN\) return/);
    expect(js).toMatch(/f\.contentWindow === e\.source/);
    expect(js).toMatch(/typeof d\.height !== 'number'/);
  });
  test('only mounts a valid wgt_ key (never injects an arbitrary iframe URL) and encodes it', () => {
    expect(js).toMatch(/KEY_RE = \/\^wgt_\[a-f0-9\]\{36\}\$\//);
    expect(js).toMatch(/if \(!KEY_RE\.test\(key\)\) return/);
    expect(js).toMatch(/encodeURIComponent\(key\)/);
  });
  test('contains no secrets/credentials (no auth headers, tokens, or key assignments)', () => {
    expect(js).not.toMatch(/Authorization|Bearer|sk_live|sk_test|api[_-]?key\s*[:=]/i);
  });
});

// ── Marketing surfaces advertise the now-certified feature ──────────────────────
describe('white-label marketing copy (post-certification)', () => {
  test('professional-sellers.html advertises "host auctions on your own website"', () => {
    const p = read('public', 'professional-sellers.html');
    expect(p).toMatch(/host auctions on your own website/i);
    expect(p).toMatch(/white-label/i);
  });
  test('the Free -> Pro upgrade panel lists the widget benefit', () => {
    expect(read('public', 'widgets', 'shared', 'pro-upgrade-panel.js')).toMatch(/host auctions on your own website/i);
  });
});

// ── Dashboard install card ───────────────────────────────────────────────────────
describe('seller dashboard install card', () => {
  const dash = read('public', 'seller-dashboard.html');
  test('fetches the owner-scoped config, shows install code + copy + preview, hidden for non-pros', () => {
    expect(dash).toMatch(/\/api\/sellers\/me\/widget/);
    expect(dash).toMatch(/Add Auctions to Your Website/);
    expect(dash).toMatch(/Copy Code/);
    expect(dash).toMatch(/if \(!d \|\| !d\.success \|\| !d\.eligible\) return/); // section stays hidden
    expect(dash).toMatch(/preview_url/);
  });
});
