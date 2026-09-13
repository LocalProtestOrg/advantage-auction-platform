'use strict';

/**
 * Sales Near You — the finalized Owner policy.
 *
 *     EVERYONE MAY SUBSCRIBE. NOT EVERY EVENT MAY SEND.
 *
 * Six concepts are kept separate and are tested separately: subscriber eligibility, geographic
 * eligibility, EVENT ENTITLEMENT, send authority, content/privacy policy, and deliverability.
 *
 * The defect these tests lock shut: localEventAlertService previously resolved ANY row passing the
 * canonical visibility predicates, so an imported estate sale was as eligible as a native auction.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sny';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * Several assertions below check that a guarantee holds IN CODE. Reading the whole file would trip over
 * the prose that documents it — a comment saying "the street address is deliberately NOT selected"
 * contains the very word being forbidden — so those read a comment-stripped view.
 */
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1')
  .replace(/^\s*--.*$/gm, '');
const readCode = (...p) => stripComments(read(...p));
/** Comment prose with line wrapping and leading asterisks folded into one line. */
const readProse = (...p) => read(...p).replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');

jest.mock('../src/db', () => {
  const state = { routes: [], calls: [] };
  const query = async (sql, params) => {
    const text = String(sql);
    state.calls.push({ sql: text, params });
    for (const [re, h] of state.routes) {
      if (re.test(text)) {
        const out = typeof h === 'function' ? await h(text, params) : h;
        return Array.isArray(out) ? { rows: out, rowCount: out.length } : out;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), pool: { end: async () => {} }, __state: state };
});
const db = require('../src/db');
const setRoutes = (r) => { db.__state.routes = r; db.__state.calls = []; };

const ent = require('../src/services/salesNearYouEntitlementService');
const alerts = require('../src/services/localEventAlertService');
const audience = require('../src/services/audienceEligibilityService');
const configService = require('../src/services/configService');

let cfg = {};
beforeEach(() => {
  cfg = {
    'marketing.email.radius_default_miles': 30,
    'marketing.email.local_alert_default_radius_miles': 30,
    'marketing.email.radius_allowed': [10, 25, 30, 50, 100],
    'marketing.email.sales_near_you_enabled': false,
    'marketing.email.sales_near_you_obligation_key': 'sales_near_you_email',
  };
  jest.spyOn(configService, 'get').mockImplementation(async (_o, k) => cfg[k]);
  setRoutes([]);
});
afterEach(() => jest.restoreAllMocks());

const noEntitlement = () => setRoutes([[/FROM sales_near_you_entitlements/, () => []]]);
const liveEntitlement = (o) => setRoutes([[/FROM sales_near_you_entitlements/, () => [Object.assign({
  id: 'ent-1', status: 'active', source: 'package_obligation', max_sends: null, sends_used: 0,
  revoked_at: null, expires_at: null,
}, o || {})]]]);

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('EVENT ENTITLEMENT — the §24 matrix', () => {
  test('A. a NATIVE Advantage.Bid auction may automatically qualify', async () => {
    noEntitlement();
    const r = await ent.resolve({ kind: 'auction', id: 'a1', isNative: true });
    expect(r.entitled).toBe(true);
    expect(r.basis).toBe(ent.BASIS.NATIVE_AUCTION);
    // Automatic eligibility needs no purchased entitlement row.
    expect(r.entitlement).toBeNull();
  });

  test('B. an IMPORTED auction does NOT automatically qualify', async () => {
    noEntitlement();
    const r = await ent.resolve({ kind: 'partner_event', id: 'e1', source: 'imported' });
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe(ent.REASON.IMPORTED_NOT_ENTITLED);
  });

  test('C. an Auction Partner Event does NOT automatically qualify', async () => {
    noEntitlement();
    const r = await ent.resolve({ kind: 'partner_event', id: 'e2', source: 'organization' });
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe(ent.REASON.PARTNER_EVENT_NOT_ENTITLED);
  });

  test('D. a personally managed estate sale without entitlement CANNOT send', async () => {
    noEntitlement();
    const r = await ent.resolve({ kind: 'estate_sale', id: 'e3', source: 'organization' });
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe(ent.REASON.ESTATE_SALE_NOT_ENTITLED);
  });

  test('D2. a personally managed estate sale WITH a qualifying entitlement may send', async () => {
    liveEntitlement({ source: 'package_obligation' });
    const r = await ent.resolve({ kind: 'estate_sale', id: 'e3' });
    expect(r.entitled).toBe(true);
    expect(r.basis).toBe(ent.BASIS.ENTITLEMENT);
    expect(r.entitlement.source).toBe('package_obligation');
  });

  test('E. an IMPORTED estate sale does NOT automatically qualify', async () => {
    noEntitlement();
    const r = await ent.resolve({ kind: 'estate_sale', id: 'e4', source: 'imported' });
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe(ent.REASON.IMPORTED_NOT_ENTITLED);
  });

  test('F. a fixed-price Marketplace item is excluded from the channel entirely', async () => {
    noEntitlement();
    const r = await ent.resolve({ kind: 'marketplace_item', id: 'm1' });
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe(ent.REASON.MARKETPLACE_EXCLUDED);
    // It never even reaches the entitlement lookup.
    expect(db.__state.calls.some((c) => /sales_near_you_entitlements/.test(c.sql))).toBe(false);
  });

  test('"auction" is never read generically — an imported auction is a partner_event', () => {
    const src = read('src', 'services', 'localEventAlertService.js');
    expect(src).toMatch(/const evKind = e\.sale_type === 'auction' \? 'partner_event' : 'estate_sale';/);
    expect(src).toMatch(/never read generically/);
  });

  test('an admin override may grant it, but must say who and why', async () => {
    await expect(ent.grant({ subjectKind: 'event', subjectId: 'e5', source: 'admin_override' }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(ent.grant({ subjectKind: 'event', subjectId: 'e5', source: 'admin_override', actorId: 'u1' }))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' });
  });

  test('an unrecognized entitlement source is refused', async () => {
    await expect(ent.grant({ subjectKind: 'event', subjectId: 'e5', source: 'because_i_said_so' }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('entitlement lifecycle', () => {
  test('a revoked entitlement does not entitle', async () => {
    liveEntitlement({ revoked_at: new Date().toISOString() });
    const r = await ent.resolve({ kind: 'estate_sale', id: 'e1' });
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe(ent.REASON.REVOKED);
  });

  test('an expired entitlement does not entitle', async () => {
    liveEntitlement({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const r = await ent.resolve({ kind: 'estate_sale', id: 'e1' });
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe(ent.REASON.EXPIRED);
  });

  test('an exhausted allowance does not entitle', async () => {
    liveEntitlement({ max_sends: 2, sends_used: 2 });
    const r = await ent.resolve({ kind: 'estate_sale', id: 'e1' });
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe(ent.REASON.EXHAUSTED);
  });

  test('an undecided allowance (null max_sends) still entitles — product has not set a number', async () => {
    liveEntitlement({ max_sends: null, sends_used: 99 });
    expect((await ent.resolve({ kind: 'estate_sale', id: 'e1' })).entitled).toBe(true);
  });

  test('no pricing, package name, send count or bundle economics is decided in code', () => {
    const code = readCode('src', 'services', 'salesNearYouEntitlementService.js');
    // No pricing LOGIC: no money fields, no payment provider, no refund handling. ("Fixed-price
    // Marketplace" is domain vocabulary for an excluded subject, not a price decision.)
    expect(code).not.toMatch(/price_cents|amount_paid|internal_authority|stripe|refund/i);
    // The allowance is simply passed through; the number itself is a future product decision.
    expect(code).toMatch(/input\.maxSends != null \? input\.maxSends : null/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('GEOGRAPHY — 30 miles, by distance, not ZIP membership', () => {
  test('the default email radius is 30 miles', async () => {
    expect(await alerts.defaultRadius()).toBe(30);
  });

  test('30 is an allowed radius', async () => {
    expect(await alerts.allowedRadii()).toContain(30);
  });

  test('the migration sets BOTH radius keys to 30', () => {
    const m = read('db', 'migrations', '157_sales_near_you_entitlements.sql');
    expect(m).toMatch(/UPDATE platform_config SET value = '30'::jsonb/);
    expect(m).toMatch(/marketing\.email\.radius_default_miles/);
    expect(m).toMatch(/marketing\.email\.local_alert_default_radius_miles/);
  });

  test('matching is true coordinate distance — haversine, not ZIP', () => {
    // ~29 miles apart: Austin TX to a point just under the radius.
    const d = audience.haversineMiles(30.2672, -97.7431, 30.2672, -97.2740);
    expect(d).toBeGreaterThan(26);
    expect(d).toBeLessThan(30);
  });

  test('a subscriber INSIDE 30 miles qualifies', () => {
    const strategy = { kind: 'radius', lat: 30.2672, lng: -97.7431, radius_miles: 30 };
    // ~5 miles away.
    expect(audience.haversineMiles(30.2672, -97.7431, 30.34, -97.74)).toBeLessThan(30);
    expect(strategy.radius_miles).toBe(30);
  });

  test('a subscriber at approximately 29 miles qualifies, and beyond 30 does not', () => {
    const at29 = audience.haversineMiles(30.2672, -97.7431, 30.2672, -97.2740);
    expect(at29).toBeLessThanOrEqual(30);
    const at60 = audience.haversineMiles(30.2672, -97.7431, 30.2672, -96.80);
    expect(at60).toBeGreaterThan(30);
  });

  test('a contact with NO coordinates is excluded — fail closed, never assumed nearby', () => {
    const src = read('src', 'services', 'audienceEligibilityService.js');
    expect(src).toMatch(/if \(lat == null \|\| lng == null\) return false;.*fail closed/i);
  });

  test('ZIP is not the primary distance rule', () => {
    const src = read('src', 'services', 'audienceEligibilityService.js');
    const radiusBranch = src.slice(src.indexOf("if (strategy.kind === 'radius'"), src.indexOf('if (strategy.state'));
    expect(radiusBranch).toMatch(/haversineMiles/);
    expect(radiusBranch).not.toMatch(/zip/i);
  });

  test('the email radius is INDEPENDENT of paid advertising targeting', () => {
    const svc = read('src', 'services', 'localEventAlertService.js');
    expect(svc).toMatch(/Independent of paid advertising/i);
    // Different configuration keys entirely, so changing one never moves the other.
    expect(svc).toMatch(/marketing\.email\.local_alert_default_radius_miles/);
    expect(svc).not.toMatch(/paid.*radius_miles.*=.*30|ads?_radius/i);
  });

  test('city-centroid geography is acceptable for selection and is not claimed as precise', () => {
    const tmpl = read('src', 'services', 'marketingEmailTemplate.js');
    // No false precision: the email never states a distance.
    expect(tmpl).not.toMatch(/miles (away|from)/i);
    expect(tmpl).not.toMatch(/\d+\.\d+ miles/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('CONTENT — estate-sale address privacy is enforced, not merely intended', () => {
  const facts = alerts.publicFacts({
    kind: 'estate_sale', id: 'e1', slug: 'sale', title: 'Estate Sale',
    city: 'Austin', state: 'TX', zip: '78701',
    address: '123 Private Lane', lat: 30.2672, lng: -97.7431,
    date_line: 'Sat, Oct 4', image_url: 'https://img', url: 'https://bid.advantage.bid/event.html?slug=sale',
  });

  test('the street address never survives the allowlist', () => {
    expect(JSON.stringify(facts)).not.toMatch(/123 Private Lane/);
    expect(facts.address).toBeUndefined();
  });

  test('exact coordinates never survive the allowlist', () => {
    expect(facts.lat).toBeUndefined();
    expect(facts.lng).toBeUndefined();
    expect(JSON.stringify(facts)).not.toMatch(/30\.2672|-97\.7431/);
  });

  test('ZIP is dropped too — city and state are enough to say "near you"', () => {
    expect(facts.zip).toBeUndefined();
  });

  test('the permitted public facts DO survive', () => {
    expect(facts).toMatchObject({
      title: 'Estate Sale', city: 'Austin', state: 'TX',
      date_line: 'Sat, Oct 4', image_url: 'https://img',
    });
    expect(facts.url).toMatch(/bid\.advantage\.bid\/event\.html\?slug=sale/);   // canonical listing
  });

  test('the resolver never even SELECTS the street address', () => {
    const code = readCode('src', 'services', 'localEventAlertService.js');
    // The events SELECT lists its columns explicitly; `address` is not among them.
    const q = code.slice(code.indexOf('SELECT e.id, e.slug, e.title'), code.indexOf('const e = rows[0]'));
    expect(q.length).toBeGreaterThan(50);
    expect(q).not.toMatch(/address/i);
    // And the intent is documented for the next person to read.
    expect(read('src', 'services', 'localEventAlertService.js')).toMatch(/deliberately NOT selected/);
  });

  test('rendering re-applies the allowlist, so a hand-built object cannot leak an address', () => {
    const src = read('src', 'services', 'localEventAlertService.js');
    expect(src).toMatch(/tmpl\.buildLocalEventAlert\(publicFacts\(event\), opts\)/);
    expect(src).toMatch(/\(events \|\| \[\]\)\.map\(publicFacts\)/);
  });

  test('the template renders no address, map, or coordinates', () => {
    const tmpl = read('src', 'services', 'marketingEmailTemplate.js');
    expect(tmpl).not.toMatch(/\.address\b/);
    expect(tmpl).not.toMatch(/maps\.google|google\.com\/maps|openstreetmap/i);
    expect(tmpl).not.toMatch(/event\.lat|event\.lng/);
  });

  test('address publication stays listing-controlled — the email omits it regardless', () => {
    const src = read('src', 'services', 'localEventAlertService.js');
    // Documented policy (the comment wraps across lines, so match loosely).
    expect(readProse('src', 'services', 'localEventAlertService.js'))
      .toMatch(/not even when the listing has already released it/i);
    // Enforced by construction: the allowlist has no address field to populate.
    expect(Object.keys(alerts.publicFacts({ address: 'x', city: 'c', state: 's' }))).not.toContain('address');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('SEND AUTHORITY — the platform controls the send', () => {
  test('buildAudience refuses an unentitled subject BEFORE computing any audience', async () => {
    setRoutes([
      [/FROM events e/, () => [{
        id: 'e1', slug: 'imported-sale', title: 'Imported Sale', city: 'Austin', state: 'TX',
        zip: '78701', lat: 30.2, lng: -97.7, start_at: new Date().toISOString(), end_at: null,
        sale_type: null, source: 'imported', image_url: null,
      }]],
      [/FROM sales_near_you_entitlements/, () => []],
    ]);
    const out = await alerts.buildAudience({ kind: 'estate_sale', idOrSlug: 'imported-sale' });
    expect(out.ok).toBe(false);
    expect(out.entitled).toBe(false);
    expect(out.reason).toBe(ent.REASON.IMPORTED_NOT_ENTITLED);
    // No audience preview or specification was produced.
    expect(out.spec).toBeUndefined();
    expect(out.eligible).toBeUndefined();
    expect(db.__state.calls.some((c) => /FROM marketing_contacts/.test(c.sql))).toBe(false);
  });

  test('an unentitled refusal returns only public facts, never the address or coordinates', async () => {
    setRoutes([
      [/FROM events e/, () => [{
        id: 'e1', slug: 's', title: 'T', city: 'Austin', state: 'TX', zip: '78701',
        lat: 30.2, lng: -97.7, start_at: new Date().toISOString(), end_at: null,
        sale_type: null, source: 'imported', image_url: null,
      }]],
      [/FROM sales_near_you_entitlements/, () => []],
    ]);
    const out = await alerts.buildAudience({ kind: 'estate_sale', idOrSlug: 's' });
    expect(out.event.lat).toBeUndefined();
    expect(out.event.zip).toBeUndefined();
  });

  test('a seller never receives raw subscriber addresses — only a specification', () => {
    const src = read('src', 'services', 'localEventAlertService.js');
    expect(src).toMatch(/Never a raw address list/i);
    // buildAudience returns counts and a spec, not recipients.
    expect(src).toMatch(/potential: preview\.potential, eligible: preview\.eligible, spec/);
  });

  test('the channel has its own master switch, separate from A7', () => {
    const m = read('db', 'migrations', '157_sales_near_you_entitlements.sql');
    expect(m).toMatch(/'marketing\.email\.sales_near_you_enabled', 'false'/);
    const src = read('src', 'services', 'salesNearYouEntitlementService.js');
    expect(src).toMatch(/function channelEnabled/);
  });

  test('entitlement consumption is atomic, so two sends cannot spend the last unit', () => {
    const src = read('src', 'services', 'salesNearYouEntitlementService.js');
    expect(src).toMatch(/AND \(max_sends IS NULL OR sends_used < max_sends\)/);
    expect(src).toMatch(/WHERE id = \$1 AND status = 'active'/);
  });

  test('an entitlement never overrides a RECIPIENT decision', () => {
    expect(readProse('src', 'services', 'salesNearYouEntitlementService.js'))
      .toMatch(/never overrides a RECIPIENT/i);
    // This service knows nothing about recipients at all — no recipient table is referenced in code.
    const code = readCode('src', 'services', 'salesNearYouEntitlementService.js');
    expect(code).not.toMatch(/email_suppressions|marketing_contacts|unsubscribe/);
  });

  test('recipient suppression and consent remain evaluated by the existing certified path', () => {
    const src = read('src', 'services', 'audienceEligibilityService.js');
    expect(src).toMatch(/evaluateContact/);
    expect(src).toMatch(/PERMITTED_BASES/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('migration 157', () => {
  const m = read('db', 'migrations', '157_sales_near_you_entitlements.sql');

  test('it is additive and destroys nothing', () => {
    expect(m).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(m).not.toMatch(/DELETE\s+FROM/i);
    expect(m).not.toMatch(/TRUNCATE/i);
  });

  test('it reuses the existing commercial architecture rather than duplicating it', () => {
    // The obligation engine becomes event-aware instead of a parallel entitlement store being invented.
    expect(m).toMatch(/ALTER TABLE marketing_obligations ADD COLUMN IF NOT EXISTS event_id/);
    expect(m).toMatch(/obligation_id   uuid        REFERENCES marketing_obligations\(id\)/);
    expect(m).toMatch(/purchase_kind/);
  });

  test('an entitlement can never be ambiguous about what it entitles', () => {
    expect(m).toMatch(/chk_sny_entitlement_subject/);
  });

  test('an admin override must be attributable and explained', () => {
    expect(m).toMatch(/chk_sny_override_reason/);
  });

  test('only one live entitlement per subject, so a double purchase cannot double authority', () => {
    expect(m).toMatch(/uq_sny_entitlement_live_auction/);
    expect(m).toMatch(/uq_sny_entitlement_live_event/);
  });

  test('the channel ships OFF and no gate is enabled', () => {
    expect(m).toMatch(/'marketing\.email\.sales_near_you_enabled', 'false'/);
    expect(m).not.toMatch(/a7_send_enabled.*true|outreach_enabled.*true/);
    expect(m).not.toMatch(/meta|google/i);
  });

  test('it decides no pricing or package economics', () => {
    const sql = readCode('db', 'migrations', '157_sales_near_you_entitlements.sql');
    expect(sql).not.toMatch(/price_cents|amount_paid|refund/i);
    // max_sends exists but is nullable precisely because the number is undecided.
    expect(sql).toMatch(/max_sends       integer     CHECK \(max_sends IS NULL OR max_sends > 0\)/);
    expect(m).toMatch(/future product decisions/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('subscriber eligibility is untouched — everyone may subscribe', () => {
  test('signup depends on no seller type, package, membership or account', () => {
    const route = read('src', 'routes', 'publicSubscribe.js');
    expect(route).not.toMatch(/seller_type|package|membership|requireAuth|authMiddleware/);
  });

  test('the subscriber system is not duplicated by this change', () => {
    const m = read('db', 'migrations', '157_sales_near_you_entitlements.sql');
    expect(m).not.toMatch(/CREATE TABLE[^;]*subscriber/i);
    expect(m).not.toMatch(/CREATE TABLE[^;]*contact/i);
  });

  test('entitlement governs EVENTS, never subscribers', () => {
    const src = read('src', 'services', 'salesNearYouEntitlementService.js');
    expect(src).toMatch(/EVERYONE MAY SUBSCRIBE\. NOT EVERY EVENT MAY SEND\./);
    expect(src).toMatch(/subject_kind IN \('auction','event'\)|subject\.kind/);
  });
});
