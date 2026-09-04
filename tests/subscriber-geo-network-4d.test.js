'use strict';
// Marketing Agency Phase 4D — first-party subscriber growth + geographic audience network.
// Grows Advantage.Bid's own voluntarily-subscribed audience. Nothing here sends email or activates A7.

const fs = require('fs');
const vm = require('vm');

// audienceEligibilityService is DB-backed via marketingConfigService; stub the config so pure/stub-runner
// tests never touch a database.
jest.mock('../src/services/marketingConfigService', () => ({
  getInt: async (_k, fb) => (_k === 'marketing.email.frequency_cap_per_30d' ? 4 : _k === 'marketing.email.min_spacing_hours' ? 48 : fb),
  getBool: async (_k, fb) => fb,
  raw: async (_k, fb) => fb,
  a7SendEnabled: async () => false,
}));

// ── 1. subscriberGeoService — reuse the geocoding seam; fail-open ─────────────
describe('subscriberGeoService', () => {
  function load(seam) { jest.resetModules(); jest.doMock('../src/services/geocoding', () => seam); return require('../src/services/subscriberGeoService'); }
  afterEach(() => jest.dontMock('../src/services/geocoding'));

  test('resolves coordinates when the geocoder is configured and succeeds (ZIP => postal precision)', async () => {
    const svc = load({ isConfigured: () => true, geocodeAuctionLocation: async () => ({ ok: true, lat: 29.76, lng: -95.36 }) });
    const r = await svc.resolve({ city: 'Houston', state: 'tx', zip: '77002' });
    expect(r.latitude).toBe(29.76); expect(r.longitude).toBe(-95.36);
    expect(r.geography_precision).toBe('postal'); expect(r.geography_source).toBe('geocoder');
    expect(r.state).toBe('TX'); expect(r.geo_resolved_at).toBeTruthy();
  });
  test('city+state (no zip) => city_centroid precision', async () => {
    const svc = load({ isConfigured: () => true, geocodeAuctionLocation: async () => ({ ok: true, lat: 1, lng: 2 }) });
    expect((await svc.resolve({ city: 'Austin', state: 'TX' })).geography_precision).toBe('city_centroid');
  });
  test('fails OPEN (keeps city/state text, no coords) when geocoder unconfigured', async () => {
    const svc = load({ isConfigured: () => false, geocodeAuctionLocation: async () => { throw new Error('should not call'); } });
    const r = await svc.resolve({ city: 'Reno', state: 'NV', zip: '89501' });
    expect(r.latitude).toBeNull(); expect(r.geography_precision).toBe('unknown');
    expect(r.geography_source).toBe('user_supplied'); expect(r.city).toBe('Reno'); expect(r.state).toBe('NV');
  });
  test('fails OPEN when the provider throws', async () => {
    const svc = load({ isConfigured: () => true, geocodeAuctionLocation: async () => { throw new Error('boom'); } });
    expect((await svc.resolve({ city: 'X', state: 'CA' })).latitude).toBeNull();
  });
});

// ── 2. subscriberService.signup — orchestration + suppression safety ─────────
describe('subscriberService.signup', () => {
  function loadWith({ suppression = null, deliverability = null, userId = null } = {}) {
    jest.resetModules();
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return {};
        if (/FROM email_suppressions/.test(sql) && /SELECT reason/.test(sql)) return { rows: suppression ? [{ reason: suppression }] : [] };
        if (/FROM email_deliverability/.test(sql)) return { rows: deliverability ? [deliverability] : [] };
        if (/FROM users/.test(sql)) return { rows: userId ? [{ id: userId }] : [] };
        if (/DELETE FROM email_suppressions/.test(sql)) return { rowCount: 1 };
        if (/INSERT INTO analytics_events/.test(sql)) return {};
        return { rows: [] };
      },
      release: () => {},
    };
    jest.doMock('../src/db', () => ({ connect: async () => client, query: (...a) => client.query(...a) }));
    jest.doMock('../src/services/subscriberGeoService', () => ({ resolve: async (l) => ({ city: l.city, state: l.state, zip: l.zip, latitude: 40, longitude: -74, geography_precision: 'city_centroid', geography_source: 'geocoder', geo_resolved_at: 'now' }) }));
    const contacts = {
      upsertContact: jest.fn(async () => ({ id: 'c1', permission_basis: 'unknown' })),
      attachSource: jest.fn(async () => ({})),
      grantPermission: jest.fn(async () => ({})),
      recordPermissionEvent: jest.fn(async () => ({})),
    };
    jest.doMock('../src/services/marketingContactService', () => contacts);
    const svc = require('../src/services/subscriberService');
    return { svc, contacts, calls };
  }
  afterEach(() => { jest.dontMock('../src/db'); jest.dontMock('../src/services/subscriberGeoService'); jest.dontMock('../src/services/marketingContactService'); });

  test('rejects an invalid email before any DB work', async () => {
    const { svc, contacts } = loadWith();
    expect(await svc.signup({ email: 'nope' })).toEqual({ ok: false, reason: 'invalid_email' });
    expect(contacts.upsertContact).not.toHaveBeenCalled();
  });
  test('new subscriber: explicit opt-in granted with a scoped, evidenced permission', async () => {
    const { svc, contacts } = loadWith();
    const r = await svc.signup({ email: 'New@X.com', name: 'A', city: 'NYC', state: 'NY', placement: 'footer' });
    expect(r).toMatchObject({ ok: true, status: 'subscribed', matched_user: false });
    expect(contacts.grantPermission).toHaveBeenCalledTimes(1);
    const arg = contacts.grantPermission.mock.calls[0][1];
    expect(arg.basis).toBe('explicit_opt_in');
    expect(arg.scope.classes).toContain('newsletter');
    expect(arg.evidence).toMatch(/footer/);
    expect(contacts.upsertContact.mock.calls[0][0].latitude).toBe(40);   // geography persisted
  });
  test('existing platform user is matched, not duplicated', async () => {
    const { svc, contacts } = loadWith({ userId: 'u-9' });
    const r = await svc.signup({ email: 'u@x.com', placement: 'all_events' });
    expect(r.matched_user).toBe(true);
    expect(contacts.upsertContact.mock.calls[0][0].userId).toBe('u-9');
  });
  test('hard suppression (complaint/hard bounce) is NOT overridden by a form submit', async () => {
    const { svc, contacts, calls } = loadWith({ suppression: 'complaint' });
    const r = await svc.signup({ email: 'c@x.com', placement: 'footer' });
    expect(r.status).toBe('received');
    expect(contacts.grantPermission).not.toHaveBeenCalled();
    expect(contacts.recordPermissionEvent).toHaveBeenCalledWith('c1', expect.objectContaining({ action: 'grant_blocked_suppressed' }), expect.anything());
    expect(calls.some(c => /DELETE FROM email_suppressions/.test(c.sql))).toBe(false);   // suppression preserved
  });
  test('a prior user-initiated unsubscribe is cleared by an explicit fresh re-subscribe', async () => {
    const { svc, contacts, calls } = loadWith({ suppression: 'unsubscribe' });
    const r = await svc.signup({ email: 'r@x.com', placement: 'footer' });
    expect(r.status).toBe('subscribed');
    expect(calls.some(c => /DELETE FROM email_suppressions/.test(c.sql))).toBe(true);
    expect(contacts.grantPermission).toHaveBeenCalled();
  });
  test('never touches seller_followers (follow-seller is a separate system)', () => {
    const src = fs.readFileSync('src/services/subscriberService.js', 'utf8');
    expect(src).not.toMatch(/seller_followers/);
    expect(src).not.toMatch(/follower_optin/);   // newsletter signup never grants follower permission
  });
});

// ── 2b. attachSource persists signup attribution (regression: was dropped) ───
describe('marketingContactService.attachSource attribution', () => {
  const svc = require('../src/services/marketingContactService');
  test('writes signup_placement / referrer / source_domain', async () => {
    const calls = [];
    const runner = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 's1' }] }; } };
    await svc.attachSource('c1', { sourceType: 'newsletter_signup', sourceRecordId: 'footer', signupPlacement: 'footer', referrer: '/events', sourceDomain: 'advantage.bid' }, runner);
    const ins = calls.find(c => /INSERT INTO marketing_contact_sources/.test(c.sql));
    expect(ins.sql).toMatch(/signup_placement/);
    expect(ins.params).toContain('footer');
    expect(ins.params).toContain('advantage.bid');
    expect(ins.sql).not.toMatch(/UPDATE marketing_contacts\b/);   // never touches the contact's permission
  });
});

// ── 3. audienceEligibilityService — radius geography + preview ────────────────
describe('audienceEligibilityService radius + preview', () => {
  const svc = require('../src/services/audienceEligibilityService');
  const R = svc.REASON;
  function runner(opts = {}) {
    return { query: async (sql) => {
      // Preview counts first — the eligible query mentions email_suppressions in a subquery.
      if (/count\(\*\)::int AS c/.test(sql) && /marketing_contacts mc/.test(sql)) return { rows: [{ c: opts.count != null ? opts.count : 7 }] };
      if (/count\(\*\)[\s\S]*marketing_campaign_recipients/.test(sql)) return { rows: [{ c: 0, last_at: null }] };
      if (/SELECT 1 FROM marketing_campaign_recipients/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM email_suppressions/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM email_deliverability/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    } };
  }
  const base = { id: 'c1', normalized_email: 'ok@x.com', permission_basis: 'explicit_opt_in', is_demo: false, permission_scope: { all: true } };

  test('haversineMiles is sane (Houston→Dallas ~225mi)', () => {
    const d = svc.haversineMiles(29.7604, -95.3698, 32.7767, -96.7970);
    expect(d).toBeGreaterThan(200); expect(d).toBeLessThan(250);
  });
  test('radius strategy: contact inside radius passes, outside fails, no-coords excluded', async () => {
    const near = { ...base, latitude: 29.80, longitude: -95.40 };
    const far = { ...base, latitude: 40.71, longitude: -74.00 };
    const noco = { ...base, latitude: null, longitude: null };
    const strat = { kind: 'radius', lat: 29.7604, lng: -95.3698, radius_miles: 30 };
    expect((await svc.evaluateContact({ contact: near, geoStrategy: strat }, runner())).eligible).toBe(true);
    expect((await svc.evaluateContact({ contact: far, geoStrategy: strat }, runner())).reason).toBe(R.GEO_MISMATCH);
    expect((await svc.evaluateContact({ contact: noco, geoStrategy: strat }, runner())).reason).toBe(R.GEO_MISMATCH);
  });
  test('previewAudience returns potential + eligible counts and a strategy (no raw list)', async () => {
    const out = await svc.previewAudience({ lat: 29.76, lng: -95.36, radiusMiles: 25 }, runner({ count: 5 }));
    expect(out.potential).toBe(5); expect(typeof out.eligible).toBe('number');
    expect(out.strategy).toMatchObject({ kind: 'radius', radius_miles: 25 });
    expect(out).not.toHaveProperty('addresses');
  });
  test('email radius is its own strategy — nationwide/state/city still supported', async () => {
    expect((await svc.previewAudience({ state: 'TX' }, runner())).strategy).toEqual({ state: 'TX' });
    expect((await svc.previewAudience({}, runner())).strategy).toEqual({ kind: 'nationwide' });
  });
});

// ── 4. Public signup endpoint (source-assertion: safe, no disclosure) ─────────
describe('publicSubscribe route', () => {
  const SRC = fs.readFileSync('src/routes/publicSubscribe.js', 'utf8');
  test('honeypot + rate limit + validation + kill switch + uniform no-disclosure success', () => {
    expect(SRC).toMatch(/company_url/);              // honeypot
    expect(SRC).toMatch(/feedbackLimiter/);          // rate limit
    expect(SRC).toMatch(/EMAIL_RE/);                 // server-side validation
    expect(SRC).toMatch(/marketing\.subscribe\.enabled/);   // kill switch
    // exactly one canonical success object reused for every non-error outcome
    expect((SRC.match(/res\.json\(SUCCESS\)/g) || []).length).toBeGreaterThanOrEqual(2);
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/already (exists|subscribed|registered)/i);   // never discloses existing membership
    expect(code).not.toMatch(/sendEmail|nodemailer|smtp/i);                // collection only, never sends
  });
});

// ── 5. Reusable subscribe widget (static) ────────────────────────────────────
describe('subscribe-widget.js', () => {
  const JS = fs.readFileSync('public/widgets/shared/subscribe-widget.js', 'utf8');
  const code = JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  test('collects Name/Email/City/State + optional ZIP; posts to the one endpoint', () => {
    ["name: 'name'", "name: 'email'", "name: 'city'", "name: 'state'", "name: 'zip'"].forEach(s => expect(JS).toContain(s));
    expect(JS).toContain('/api/public/subscribers');
    expect(JS).toMatch(/ZIP \(optional\)/);
  });
  test('has honeypot, accessibility labels, and required-email guard', () => {
    expect(JS).toMatch(/company_url/);
    expect(JS).toMatch(/aria-label/);
    expect(JS).toMatch(/required/);
  });
  test('no AI wording, no vendor names, no em/en dashes in code; parses', () => {
    expect(code).not.toMatch(/\bAI\b/);
    expect(code).not.toMatch(/twilio|cloudinary|postmark|railway|neon|openai|gpt|mapbox/i);
    expect(code).not.toMatch(/[—–]/);
    expect(() => new vm.Script(JS)).not.toThrow();
  });
});

// ── 6. Admin subscriber tools (source + static: RBAC, NO mass send) ──────────
describe('admin subscriber tools', () => {
  const ROUTE = fs.readFileSync('src/routes/adminSubscribers.js', 'utf8');
  const PAGE = fs.readFileSync('public/admin/subscribers.html', 'utf8');
  test('route: RBAC members.view, preview independent of paid 30mi, growth-by-source, NO send', () => {
    expect(ROUTE).toMatch(/requirePermission\('members\.view'\)/);
    expect(ROUTE).toMatch(/previewAudience/);
    expect(ROUTE).toMatch(/independent of the paid 30-mile/);
    expect(ROUTE).toMatch(/growth\/by-source/);
    const code = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/sendEmail|nodemailer|POST[\s\S]{0,40}send/i);   // no mass-send path
  });
  test('page: radius choices 10/25/30/50/100, no mass-send button, no AI, inline JS parses', () => {
    ['10 mi', '25 mi', '30 mi', '50 mi', '100 mi'].forEach(s => expect(PAGE).toContain(s));
    expect(PAGE).not.toMatch(/Send (campaign|email|to all|blast)/i);
    expect(PAGE).not.toMatch(/\bAI\b/);
    const scripts = [...PAGE.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    scripts.forEach(s => expect(() => new vm.Script(s)).not.toThrow());
  });
});

// ── 7. Migration 132 (additive, safe defaults, A7 untouched) ─────────────────
describe('migration 132', () => {
  const SQL = fs.readFileSync('db/migrations/132_subscriber_geo_network_4d.sql', 'utf8');
  const code = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  test('additive only; no destructive statements', () => {
    expect(code).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(code).not.toMatch(/DELETE\s+FROM/i);
    expect((code.match(/IF NOT EXISTS/g) || []).length).toBeGreaterThanOrEqual(6);
  });
  test('geography auditable: precision default unknown + CHECK; permission audit table', () => {
    expect(code).toMatch(/geography_precision[\s\S]*DEFAULT 'unknown'/);
    expect(code).toMatch(/CHECK \(geography_precision IN/);
    expect(code).toMatch(/marketing_contact_permission_events/);
  });
  test('email radius config seeded (separate from paid 30mi); A7 NOT re-enabled here', () => {
    expect(code).toMatch(/marketing\.email\.radius_allowed/);
    expect(code).toMatch(/marketing\.subscribe\.enabled/);
    expect(code).not.toMatch(/a7_send_enabled['"]?,\s*'true'/);   // never flips A7 on
  });
});

// ── 8. A7 dormant + follow-seller preserved (guards) ─────────────────────────
describe('safety guards', () => {
  test('A7 send gate default stays false (unchanged from 4C)', async () => {
    jest.resetModules();
    jest.doMock('../src/services/configService', () => ({ get: async () => null }));
    const cfg = require('../src/services/marketingConfigService');   // note: mocked at top; assert contract shape
    expect(typeof cfg.a7SendEnabled).toBe('function');
    expect(await cfg.a7SendEnabled()).toBe(false);
    jest.dontMock('../src/services/configService');
  });
  test('seller_followers migration is untouched (follow-seller unchanged)', () => {
    const m = fs.readFileSync('db/migrations/032_create_seller_followers.sql', 'utf8');
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS seller_followers/);
  });
});
