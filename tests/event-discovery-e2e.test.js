'use strict';

/**
 * Provider-neutral event discovery, end to end on real Postgres (real migrations 076 … 168 + 208).
 *
 *   A. A WordPress-style member site with a calendar export: authorize once (dashboard route) → automatic
 *      dry-run discovery → one-time confirmation → collection gate → import with real dates, types, attribution,
 *      images from each event's own page, provenance per channel → repeat sync updates, never duplicates.
 *   B. A host that refuses the importer (edge 403 on robots.txt; a browser challenge): reported as found, never
 *      worked around; vendor-neutral seller message; push alternative works and is bound to the company's site.
 *   C. A site with only plain HTML event pages: a generic extraction profile is proposed and confirmed; its
 *      events stay in review until trusted; a layout change suspends the channel automatically.
 *   D. A third-party listing platform: no request is ever made.
 *   E. Unsafe addresses are refused before any connection.
 *   F. Revocation stops channels and sending keys at once.
 *   G. A recoverable failure asks for the bounded retry.
 *   H. Consent unification moves Member Feed Sync consent without re-dating it.
 *   I. The Marketing Director oversight reports each case with who acts.
 *
 * Fixtures are example.com companies: no real company's events are invented.
 */

const express = require('express');
const http = require('http');
const H = require('./eventDiscovery/harness');

jest.mock('../src/db', () => require('./eventDiscovery/harness').adapter());
jest.mock('../src/db/index', () => require('./eventDiscovery/harness').adapter());
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn(async () => ({ messageId: 'm' })), isConfigured: () => true }));
jest.mock('../src/services/geocoding', () => Object.assign({}, jest.requireActual('../src/services/geocoding'), { geocodeAuctionLocation: jest.fn(async () => null) }));
jest.mock('../src/services/eventGeocodingService', () => ({ deriveAndStorePublicOffset: jest.fn(async () => null) }));
jest.mock('../src/middleware/authMiddleware', () => (req, res, next) => {
  const u = global.__USERS && global.__USERS[req.get('x-test-user')];
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  req.user = { id: u.id, role: u.role, email: u.email };
  return next();
});

const db = require('../src/db');
const { withTransaction } = require('../src/utils/withTransaction');
const discovery = require('../src/services/eventDiscovery/discoveryService');
const intake = require('../src/services/eventDiscovery/intakeService');
const store = require('../src/services/eventDiscovery/channelStore');
const authorization = require('../src/services/eventPartners/authorizationService');
const { runImport } = require('../src/services/eventImport');
const oversight = require('../src/services/eventImport/partnerOversight');
const { localToUtcIso } = require('../src/lib/timezoneUtils');
const { DEFAULT_UA } = require('../src/services/eventImport/http');

const DAY = 864e5;
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const iso = (d) => d.toISOString().slice(0, 10);
const T1 = new Date(Date.now() + 20 * DAY), T2 = new Date(Date.now() + 27 * DAY);

const ORG_A = '11111111-aaaa-4aaa-8aaa-111111111111', ORG_B = '22222222-bbbb-4bbb-8bbb-222222222222', ORG_C = '33333333-cccc-4ccc-8ccc-333333333333';
const OWNER_A = '44444444-aaaa-4aaa-8aaa-444444444444', OWNER_B = '55555555-bbbb-4bbb-8bbb-555555555555', OWNER_C = '66666666-cccc-4ccc-8ccc-666666666666';
const ADMIN = '77777777-dddd-4ddd-8ddd-777777777777';

let server, base;
async function call(method, path, { user, body, headers } = {}) {
  const r = await fetch(base + path, { method, headers: Object.assign({ 'content-type': 'application/json' }, user ? { 'x-test-user': user } : {}, headers || {}),
    body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch (_) { /* empty */ }
  return { status: r.status, body: j };
}
const setGate = (on) => db.query(`INSERT INTO platform_config (key, value) VALUES ('event_partners.collection_enabled', $1::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(on)]);

// ── the fake websites ────────────────────────────────────────────────────────────────────────
const SITE_A = 'https://www.partner-a.example.com';
const ICS_A = ['BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:fall-auction@partner-a', 'SUMMARY:Fall Fine Art Auction', `DTSTART:${ymd(T1)}T100000`, `DTEND:${ymd(T1)}T180000`,
  'LOCATION:123 Main St, Houston, TX 77055', `URL:${SITE_A}/auction-catalog/fall-fine-art`, 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:west-u-estate@partner-a', 'SUMMARY:West University On-Site Estate Sale', `DTSTART:${ymd(T2)}T090000`, `DTEND:${ymd(T2)}T150000`,
  'LOCATION:456 Oak St, Houston, TX 77005', `URL:${SITE_A}/west-university-estate-sale/`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const page = (title, img) => `<html><head><title>${title}</title><meta property="og:image" content="${img}"></head><body><h1>${title}</h1></body></html>`;
function webA(overrides = {}) {
  return H.fakeWeb(Object.assign({
    [SITE_A + '/robots.txt']: { body: 'User-agent: *\nDisallow: /wp-admin/\nSitemap: ' + SITE_A + '/wp-sitemap.xml', headers: { 'content-type': 'text/plain' } },
    [SITE_A + '/']: { body: '<html><head><meta name="generator" content="WordPress 6.6"><link rel="stylesheet" href="/wp-content/themes/x.css">'
      + '<link rel="alternate" type="application/rss+xml" href="' + SITE_A + '/feed/"></head><body><a href="/upcoming-auctions/">Upcoming auctions</a></body></html>' },
    [SITE_A + '/feed/']: { body: '<rss><channel><item><title>Join us for our fall sale</title><link>' + SITE_A + '/news/</link><pubDate>Mon, 01 Sep 2026 15:00:00 GMT</pubDate></item></channel></rss>',
      headers: { 'content-type': 'application/rss+xml' } },
    [SITE_A + '/?ical=1']: { body: ICS_A, headers: { 'content-type': 'text/calendar' } },
    [SITE_A + '/auction-catalog/fall-fine-art']: { body: page('Fall Fine Art Auction', SITE_A + '/wp-content/uploads/fall.jpg') },
    [SITE_A + '/west-university-estate-sale/']: { body: page('West University On-Site Estate Sale', SITE_A + '/wp-content/uploads/westu.jpg') },
  }, overrides));
}

const SITE_B = 'https://www.partner-b.example.com';
const refused = { status: 403, body: '<title>Access Denied</title>', headers: { server: 'CloudFront', 'x-amz-cf-id': 'abc123', 'content-type': 'text/html' } };

const SITE_C = 'https://www.partner-c.example.com';
const htmlPage = (title, date, extra = '') => `<html><head><title>${title} | Partner C</title></head><body><h1>${title}</h1>`
  + `<p>Posted on September 1, 2026</p><p>Preview: ${date.preview}</p><p>Sale Dates: ${date.sale}</p><p>123 Elm St, Austin, TX 78701</p>${extra}</body></html>`;
const fmt = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
function webC(layout = 'v1') {
  const pages = {
    [SITE_C + '/robots.txt']: { body: 'User-agent: *\nAllow: /', headers: { 'content-type': 'text/plain' } },
    [SITE_C + '/']: { body: '<html><body><a href="/estate-sales/">Estate sales</a></body></html>' },
    [SITE_C + '/estate-sales/']: { body: '<html><body><a href="/estate-sale/oak-hills-estate-sale">Oak Hills Estate Sale</a><a href="/estate-sale/maple-estate-sale">Maple Estate Sale</a></body></html>' },
  };
  const d1 = { preview: fmt(new Date(T1.getTime() - DAY)), sale: fmt(T1) + ', 9:00 AM - 3:00 PM CST' };
  const d2 = { preview: fmt(new Date(T2.getTime() - DAY)), sale: fmt(T2) + ', 9:00 AM - 3:00 PM CST' };
  pages[SITE_C + '/estate-sale/oak-hills-estate-sale'] = { body: layout === 'v1' ? htmlPage('Oak Hills Estate Sale', d1) : '<html><body><div class="hero">Oak Hills</div><span>soon</span></body></html>' };
  pages[SITE_C + '/estate-sale/maple-estate-sale'] = { body: layout === 'v1' ? htmlPage('Maple Estate Sale', d2) : '<html><body><div class="hero">Maple</div><span>soon</span></body></html>' };
  return H.fakeWeb(pages);
}

beforeAll(async () => {
  global.__PG = H.startPg();
  await H.setupSchema(global.__PG);
  global.__USERS = {
    ownerA: { id: OWNER_A, role: 'seller', email: 'owner@partner-a.example.com' }, ownerB: { id: OWNER_B, role: 'seller', email: 'owner@partner-b.example.com' },
    ownerC: { id: OWNER_C, role: 'seller', email: 'owner@partner-c.example.com' }, admin: { id: ADMIN, role: 'admin', email: 'admin@advantage.bid' },
  };
  for (const u of Object.values(global.__USERS)) await db.query(`INSERT INTO users (id, email, role) VALUES ($1,$2,$3)`, [u.id, u.email, u.role]);
  for (const [id, name, slug, owner] of [[ORG_A, 'Partner A Auctions', 'partner-a', OWNER_A], [ORG_B, 'Partner B Antiques', 'partner-b', OWNER_B], [ORG_C, 'Partner C Estate Sales', 'partner-c', OWNER_C]]) {
    await db.query(`INSERT INTO organizations (id, name, slug, type, status) VALUES ($1,$2,$3,'auction_company','active')`, [id, name, slug]);
    await db.query(`INSERT INTO organization_members (organization_id, user_id, role, status) VALUES ($1,$2,'owner','active')`, [id, owner]);
  }
  const app = express();
  app.use('/api/org/event-distribution', require('../src/routes/orgEventDistribution'));
  app.use('/api/intake/v1', require('../src/routes/eventIntake'));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ success: false, code: err.code, message: err.message })); // eslint-disable-line no-unused-vars
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
}, 120000);
afterAll(async () => { if (server) server.close(); if (global.__PG) await global.__PG.close(); });

const authOf = async (org) => (await db.query(`SELECT * FROM authorized_event_sources WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`, [org])).rows[0];
const sourceOf = async (auth) => (await db.query(`SELECT * FROM import_sources WHERE id = $1`, [auth.import_source_id])).rows[0];

// ── A ────────────────────────────────────────────────────────────────────────────────────────
describe('A. a member site with a calendar export, end to end', () => {
  const web = webA();
  let auth, channel;

  test('the seller authorizes once from its dashboard (statement v2, member account)', async () => {
    const before = await call('GET', '/api/org/event-distribution', { user: 'ownerA' });
    expect(before.body.data.state).toBe('not_authorized');
    expect(before.body.data.statement.grant.join(' ')).toMatch(/send your upcoming events to Advantage\.Bid directly/);
    expect((await call('POST', '/api/org/event-distribution/authorize', { user: 'ownerA', body: { website: 'partner-a.example.com' } })).status).toBe(400); // must accept
    const r = await call('POST', '/api/org/event-distribution/authorize', { user: 'ownerA', body: { website: 'partner-a.example.com', accept: true } });
    expect(r.status).toBe(200);
    expect(r.body.data.state).toBe('checking');
    auth = await authOf(ORG_A);
    expect(auth).toMatchObject({ status: 'authorized', authorization_method: 'member_account', authorized_domain: 'partner-a.example.com', authorization_statement_version: '2026-10-29.v2' });
    expect(auth.authorization_evidence).toMatchObject({ method: 'member_account', user_id: OWNER_A });
  });

  test('a non-admin member of another company cannot authorize for it', async () => {
    const r = await call('POST', '/api/org/event-distribution/authorize', { user: 'ownerB', body: { website: 'partner-b.example.com', accept: true }, headers: { 'X-Acting-Org-Id': ORG_A } });
    expect(r.status).toBe(403);
  });

  test('automatic discovery (dry run) finds the calendar, reads robots.txt first, always as AdvantageBidBot, writes no events', async () => {
    const out = await discovery.runProbe(db, auth.id, { trigger: 'authorized', deps: web.deps });
    expect(out.result.outcome).toBe('channels_found');
    expect(web.requests[0].url).toBe('https://partner-a.example.com/robots.txt');   // robots.txt is always the first request to a host
    expect(web.requests.find((q) => q.url.startsWith(SITE_A)).url).toBe(SITE_A + '/robots.txt');
    expect(web.requests.every((q) => q.headers['User-Agent'] === DEFAULT_UA)).toBe(true);
    const ical = out.channels.find((c) => c.kind === 'ical');
    expect(ical).toMatchObject({ status: 'previewed', url: SITE_A + '/?ical=1', access_basis: 'robots_and_terms_permit' });
    expect(ical.preview.map((p) => [p.title, p.sale_type])).toEqual([['Fall Fine Art Auction', 'auction'], ['West University On-Site Estate Sale', 'estate_sale']]);
    expect(out.channels.find((c) => c.kind === 'rss')).toBeUndefined();          // a post feed without event dates is not a channel
    expect(Number((await db.query(`SELECT count(*)::int n FROM events`)).rows[0].n)).toBe(0);
    channel = ical;
    expect((await discovery.sellerStatus(db, ORG_A)).state).toBe('confirming');
  });

  test('confirmation with the platform collection switch off waits, and says so', async () => {
    await setGate(false);
    const r = await discovery.confirmChannel(db, channel.id, { actorId: ADMIN, timezone: 'America/Chicago' });
    expect(r.activation).toMatchObject({ active: false, reason: 'collection_gate_off' });
    expect((await authOf(ORG_A)).status).toBe('source_configured');
    const a = await oversight.assess(db);
    expect(a.findings.find((f) => f.code === 'COLLECTION_GATE_OFF' && f.organization_id === ORG_A)).toMatchObject({ owner: 'owner' });
  });

  test('with collection on, the next sync imports both events accurately, attributed, with their own page images', async () => {
    await setGate(true);
    expect(await discovery.syncActivation(db, auth.id, { actorId: ADMIN })).toMatchObject({ active: true });
    expect((await authOf(ORG_A)).status).toBe('collecting');
    const src = await sourceOf(await authOf(ORG_A));
    expect(src).toMatchObject({ status: 'active', owner_organization_id: ORG_A, kind: 'partner' });
    expect(src.config.connector).toBe('discovery');
    const r = await runImport({ sourceKey: src.key, apply: true, db, withTransaction, trigger: 'manual', connectorDeps: web.deps, geocodeFn: async () => null });
    expect(r.counters).toMatchObject({ fetched: 2, created: 2 });
    const ev = (await db.query(`SELECT e.*, es.channel_id, (SELECT count(*)::int FROM event_images i WHERE i.event_id = e.id) imgs
      FROM events e JOIN event_sources es ON es.event_id = e.id ORDER BY e.start_at`)).rows;
    expect(ev.map((e) => [e.title, e.sale_type, e.status, e.host_organization_id, e.host_attribution_method, e.organizer_name, e.imgs, e.channel_id]))
      .toEqual([['Fall Fine Art Auction', 'auction', 'published', ORG_A, 'authorized_source', 'Partner A Auctions', 1, channel.id],
        ['West University On-Site Estate Sale', 'estate_sale', 'published', ORG_A, 'authorized_source', 'Partner A Auctions', 1, channel.id]]);
    expect(new Date(ev[0].start_at).toISOString()).toBe(localToUtcIso(iso(T1) + 'T10:00', 'America/Chicago'));
    expect(ev[0].external_url).toBe(SITE_A + '/auction-catalog/fall-fine-art');
    expect(ev[0].organization_id).toBe(ORG_A);                                  // the company owns its own records
    const ch = await store.get(db, channel.id);
    expect(ch).toMatchObject({ last_item_count: 2, consecutive_failures: 0 });
    expect(r.partners[0]).toMatchObject({ outcome: 'ok', channel_id: channel.id, kind: 'ical' });
  });

  test('a repeated sync updates in place: no duplicate events', async () => {
    const src = await sourceOf(await authOf(ORG_A));
    const r = await runImport({ sourceKey: src.key, apply: true, db, withTransaction, trigger: 'manual', connectorDeps: web.deps, geocodeFn: async () => null });
    expect(r.counters.created).toBe(0);
    expect(r.counters.fetched).toBe(2);
    expect(Number((await db.query(`SELECT count(*)::int n FROM events WHERE host_organization_id = $1`, [ORG_A])).rows[0].n)).toBe(2);
  });

  test('the seller sees its events live, in plain language', async () => {
    const s = await call('GET', '/api/org/event-distribution', { user: 'ownerA' });
    expect(s.body.data.state).toBe('collecting');
    expect(s.body.data.message).toMatch(/2 upcoming events are live on Advantage\.Bid/);
  });
});

// ── B ────────────────────────────────────────────────────────────────────────────────────────
describe('B. a host that refuses the importer: reported, never worked around; push works instead', () => {
  let auth, key;
  test('an edge refusal on robots.txt stops the probe after ONE request and is recorded as found', async () => {
    await call('POST', '/api/org/event-distribution/authorize', { user: 'ownerB', body: { website: 'https://www.partner-b.example.com', accept: true } });
    auth = await authOf(ORG_B);
    const web = H.fakeWeb({ [SITE_B + '/robots.txt']: refused });
    const out = await discovery.runProbe(db, auth.id, { trigger: 'authorized', deps: web.deps });
    expect(out.result.outcome).toBe('blocked');
    expect(web.requests).toHaveLength(1);
    expect(out.result.blocks[0]).toMatchObject({ class: 'host_firewall_refusal', at: 'robots.txt' });
    expect(out.result.blocks[0].evidence.header).toMatch(/CloudFront/);
  });
  test('a browser challenge on the home page is recorded as a challenge (never solved)', async () => {
    const web = H.fakeWeb({ [SITE_B + '/robots.txt']: { body: 'User-agent: *\nAllow: /', headers: { 'content-type': 'text/plain' } },
      [SITE_B + '/']: { status: 202, body: '', headers: { 'x-amzn-waf-action': 'challenge', server: 'CloudFront' } } });
    const out = await discovery.runProbe(db, auth.id, { trigger: 'admin', deps: web.deps });
    expect(out.result.outcome).toBe('blocked');
    expect(out.result.blocks.map((b) => b.class)).toContain('bot_challenge');
    expect(web.requests.map((q) => q.url)).toEqual([SITE_B + '/robots.txt', SITE_B + '/']);
  });
  test('the seller is told plainly (no vendor names) and offered supported alternatives', async () => {
    const s = (await call('GET', '/api/org/event-distribution', { user: 'ownerB' })).body.data;
    expect(s.state).toBe('blocked');
    expect(s.message).not.toMatch(/CloudFront|Amazon|AWS|Invaluable|WAF/i);
    expect(s.alternatives.map((a) => a.key)).toEqual(['post', 'send', 'ask_host']);
    const req = (await call('GET', '/api/org/event-distribution/host-request', { user: 'ownerB' })).body.data;
    expect(req.text).toContain(DEFAULT_UA);
  });
  test('oversight: the block needs the owner until the company sends its events', async () => {
    let a = await oversight.assess(db);
    expect(a.findings.find((f) => f.code === 'PROBE_BLOCKED' && f.organization_id === ORG_B)).toMatchObject({ owner: 'owner', block_class: 'bot_challenge' });
    key = (await call('POST', '/api/org/event-distribution/sending-keys', { user: 'ownerB', body: { label: 'Website plugin' } })).body.data;
    expect(key.key).toMatch(/^abk_[A-Za-z0-9]{6}_/);
    expect(JSON.stringify((await db.query(`SELECT * FROM partner_intake_keys`)).rows)).not.toContain(key.key);   // stored hashed only
    a = await oversight.assess(db);
    expect(a.findings.find((f) => f.code === 'PROBE_BLOCKED' && f.organization_id === ORG_B).owner).toBe('investigate');
    expect(a.findings.find((f) => f.code === 'PUSH_NOT_STARTED' && f.organization_id === ORG_B)).toBeTruthy();
  });
  test('push: intake is off unless enabled; then only valid keys; events bound to the company site', async () => {
    const body = { events: [
      { id: 'b-1', title: 'Spring Antiques Auction', start: T1.toISOString(), end: new Date(T1.getTime() + 6 * 3600e3).toISOString(), url: SITE_B + '/catalog/spring',
        city: 'Houston', state: 'TX', sale_type: 'auction', image: SITE_B + '/img/spring.jpg' },
      { id: 'b-2', title: 'Somebody Else Sale', start: T2.toISOString(), url: 'https://other.example.org/sale', city: 'Houston', state: 'TX', image: 'https://other.example.org/i.jpg' }] };
    expect((await call('POST', '/api/intake/v1/events', { body, headers: { authorization: 'Bearer ' + key.key } })).status).toBe(503);
    process.env.EVENT_INTAKE_ENABLED = 'true';
    try {
      expect((await call('POST', '/api/intake/v1/events', { body })).status).toBe(401);
      expect((await call('POST', '/api/intake/v1/events', { body, headers: { authorization: 'Bearer abk_AAAAAA_' + 'x'.repeat(30) } })).status).toBe(401);
      expect((await call('POST', '/api/intake/v1/events', { body: { events: [{ title: 'x', nope: 1 }] }, headers: { authorization: 'Bearer ' + key.key } })).status).toBe(400);
      const r = await call('POST', '/api/intake/v1/events', { body, headers: { authorization: 'Bearer ' + key.key } });
      expect(r.status).toBe(202);
      expect(r.body.data.accepted).toBe(1);
      expect(r.body.data.rejected).toEqual([expect.objectContaining({ title: 'Somebody Else Sale', reason: 'url_offsite' })]);
      const e = (await db.query(`SELECT e.* FROM events e WHERE e.title = 'Spring Antiques Auction'`)).rows[0];
      expect(e).toMatchObject({ host_organization_id: ORG_B, sale_type: 'auction', status: 'published', organizer_name: 'Partner B Antiques' });
      expect(Number((await db.query(`SELECT count(*)::int n FROM events WHERE title = 'Somebody Else Sale'`)).rows[0].n)).toBe(0);
      const again = await call('POST', '/api/intake/v1/events', { body: { events: [body.events[0]] }, headers: { authorization: 'Bearer ' + key.key } });
      expect(again.body.data.run.counters.created).toBe(0);                       // idempotent
      const mine = await call('GET', '/api/intake/v1/events', { headers: { authorization: 'Bearer ' + key.key } });
      expect(mine.body.data.map((x) => x.title)).toEqual(['Spring Antiques Auction']);
      const run = (await db.query(`SELECT trigger FROM import_runs r JOIN import_sources s ON s.id = r.source_id WHERE s.owner_organization_id = $1 ORDER BY r.started_at DESC LIMIT 1`, [ORG_B])).rows[0];
      expect(run.trigger).toBe('push');
      const a = await oversight.assess(db);
      expect(a.findings.find((f) => f.code === 'PUSH_NOT_STARTED' && f.organization_id === ORG_B)).toBeUndefined();
      // Pausing the push channel stops the key at once; confirming it again restores it.
      const push = (await db.query(`SELECT id FROM event_collection_channels WHERE organization_id = $1 AND kind = 'push_api'`, [ORG_B])).rows[0];
      await store.setStatus(db, push.id, 'paused', { actorId: ADMIN, reason: 'test' });
      expect((await call('GET', '/api/intake/v1/events', { headers: { authorization: 'Bearer ' + key.key } })).status).toBe(401);
      await store.confirm(db, push.id, { actorId: ADMIN });
      expect((await call('GET', '/api/intake/v1/events', { headers: { authorization: 'Bearer ' + key.key } })).status).toBe(200);
    } finally { delete process.env.EVENT_INTAKE_ENABLED; }
  });
});

// ── C ────────────────────────────────────────────────────────────────────────────────────────
describe('C. plain HTML event pages: a confirmed generic profile, review first, automatic suspension on drift', () => {
  let auth, ch;
  test('discovery proposes an HTML profile from labeled sale dates (never the preview or posted date)', async () => {
    await call('POST', '/api/org/event-distribution/authorize', { user: 'ownerC', body: { website: 'partner-c.example.com', accept: true } });
    auth = await authOf(ORG_C);
    const out = await discovery.runProbe(db, auth.id, { trigger: 'authorized', deps: webC('v1').deps });
    expect(out.result.outcome).toBe('channels_found');
    ch = out.channels.find((c) => c.kind === 'html_profile');
    expect(ch).toBeTruthy();
    expect(ch.profile).toMatchObject({ version: 1 });
    expect(ch.preview.map((p) => p.title).sort()).toEqual(['Maple Estate Sale', 'Oak Hills Estate Sale']);
    const oak = ch.preview.find((p) => p.title === 'Oak Hills Estate Sale');
    expect(oak.start_at).toBe(localToUtcIso(iso(T1) + 'T09:00', 'America/Chicago'));
  });
  test('confirmed HTML events stay in review until the channel has earned trust', async () => {
    await discovery.confirmChannel(db, ch.id, { actorId: ADMIN, saleTypeHint: 'estate_sale' });
    const src = await sourceOf(await authOf(ORG_C));
    const r = await runImport({ sourceKey: src.key, apply: true, db, withTransaction, connectorDeps: webC('v1').deps, geocodeFn: async () => null });
    expect(r.counters.created).toBe(2);
    const rows = (await db.query(`SELECT status, sale_type FROM events WHERE host_organization_id = $1`, [ORG_C])).rows;
    expect(rows.every((x) => x.status === 'draft' && x.sale_type === 'estate_sale')).toBe(true);
  });
  test('a layout change suspends the channel automatically and the oversight says why', async () => {
    const src = await sourceOf(await authOf(ORG_C));
    await runImport({ sourceKey: src.key, apply: true, db, withTransaction, connectorDeps: webC('v2').deps, geocodeFn: async () => null });
    const c = await store.get(db, ch.id);
    expect(c.status).toBe('paused');
    expect(c.paused_reason).toMatch(/extraction profile/);
    const a = await oversight.assess(db);
    expect(a.findings.find((f) => f.code === 'CHANNEL_SUSPENDED' && f.organization_id === ORG_C)).toMatchObject({ owner: 'owner' });
  });
});

// ── domain claims ────────────────────────────────────────────────────────────────────────────
describe('a website the requester cannot be shown to speak for waits for an administrator', () => {
  test('pending review: nothing is read, no key can be created; an admin confirms with evidence', async () => {
    const ORG_D = '99999999-ffff-4fff-8fff-999999999999', OWNER_D = 'aaaaaaaa-ffff-4fff-8fff-aaaaaaaaaaaa';
    global.__USERS.ownerD = { id: OWNER_D, role: 'seller', email: 'someone@gmail.com' };
    await db.query(`INSERT INTO users (id, email, role) VALUES ($1,'someone@gmail.com','seller')`, [OWNER_D]);
    await db.query(`INSERT INTO organizations (id, name, slug, type, status) VALUES ($1,'Partner D','partner-d','auction_company','active')`, [ORG_D]);
    await db.query(`INSERT INTO organization_members (organization_id, user_id, role, status) VALUES ($1,$2,'owner','active')`, [ORG_D, OWNER_D]);
    const r = await call('POST', '/api/org/event-distribution/authorize', { user: 'ownerD', body: { website: 'someone-elses-site.example.com', accept: true } });
    expect(r.body.data.state).toBe('awaiting_review');
    const pending = await authOf(ORG_D);
    expect(pending).toMatchObject({ status: 'prospective', authorization_method: 'member_account' });
    expect(pending.authorization_evidence.domain_check).toMatchObject({ verified: false, via: 'needs_admin_review' });
    await expect(discovery.runProbe(db, pending.id, { deps: H.fakeWeb({}).deps })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(intake.createKey(db, pending.id, { actorId: OWNER_D })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(discovery.approveDomain(db, pending.id, { actorId: ADMIN, evidence: 'short' })).rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' });
    const ok = await discovery.approveDomain(db, pending.id, { actorId: ADMIN, evidence: 'Called the number published on the site; owner confirmed.' });
    expect(ok.status).toBe('authorized');
    expect(ok.authorization_evidence.domain_check).toMatchObject({ verified: true, via: 'admin_confirmed', by: ADMIN });
  });
});

// ── D/E ──────────────────────────────────────────────────────────────────────────────────────
describe('D/E. third-party platforms and unsafe addresses', () => {
  test('a listing platform with prohibiting terms is never contacted', async () => {
    const web = H.fakeWeb({});
    const out = await require('../src/services/eventDiscovery/probe').discover({ website: 'https://www.estatesales.net/TX/Houston', deps: web.deps });
    expect(out).toMatchObject({ outcome: 'blocked', third_party: 'estatesales_net' });
    expect(out.blocks[0].class).toBe('terms_prohibit');
    expect(web.requests).toHaveLength(0);
  });
  test('a website resolving to a private address is refused before any connection', async () => {
    const web = H.fakeWeb({}, { privateHosts: ['intranet.example.com'] });
    const out = await require('../src/services/eventDiscovery/probe').discover({ website: 'https://intranet.example.com', deps: web.deps });
    expect(out.outcome).toBe('blocked');
    expect(out.blocks[0].class).toBe('unsafe_address');
    expect(web.requests).toHaveLength(0);
  });
});

// ── F/G ──────────────────────────────────────────────────────────────────────────────────────
describe('F/G. recoverable failures retry; revocation stops everything at once', () => {
  test('a temporarily failing calendar records a failure and asks for the bounded retry', async () => {
    const src = await sourceOf(await authOf(ORG_A));
    const web = webA({ [SITE_A + '/?ical=1']: { status: 503, body: 'busy' } });
    const r = await runImport({ sourceKey: src.key, apply: true, db, withTransaction, connectorDeps: web.deps, geocodeFn: async () => null });
    expect(r.partners[0]).toMatchObject({ outcome: 'unreachable' });
    expect(r.partial_transient || r.transient).toBe(true);
    const ch = (await db.query(`SELECT * FROM event_collection_channels WHERE organization_id = $1 AND kind = 'ical'`, [ORG_A])).rows[0];
    expect(ch.consecutive_failures).toBe(1);
    const a = await oversight.assess(db);
    expect(a.findings.find((f) => f.code === 'CHANNEL_RETRYING' && f.organization_id === ORG_A)).toMatchObject({ owner: 'automatic' });
  });
  test('withdrawing retires every channel and stops every sending key in the same step', async () => {
    const key = (await intake.listKeys(db, (await authOf(ORG_B)).id)).find((k) => !k.revoked_at);
    expect(key).toBeTruthy();
    const r = await call('POST', '/api/org/event-distribution/withdraw', { user: 'ownerB', body: { reason: 'test' } });
    expect(r.status).toBe(200);
    const b = (await db.query(`SELECT * FROM authorized_event_sources WHERE organization_id = $1`, [ORG_B])).rows[0];
    expect(b.status).toBe('revoked');
    expect((await db.query(`SELECT count(*)::int n FROM event_collection_channels WHERE authorization_id = $1 AND status <> 'retired'`, [b.id])).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM partner_intake_keys WHERE authorization_id = $1 AND revoked_at IS NULL`, [b.id])).rows[0].n).toBe(0);
  });
});

// ── H ────────────────────────────────────────────────────────────────────────────────────────
describe('H. consent unification', () => {
  test('Member Feed Sync consent moves onto the one authorization record without re-dating; the shared source retires', async () => {
    const ORG_M = '88888888-eeee-4eee-8eee-888888888888';
    await db.query(`INSERT INTO organizations (id, name, slug, type, status) VALUES ($1,'Member M','member-m','auction_company','active')`, [ORG_M]);
    const consent = { granted_by: 'M owner', granted_at: '2026-10-01T15:00:00.000Z', evidence: 'signed form #12' };
    await db.query(`INSERT INTO import_sources (key, kind, name, status, config, owner_organization_id) VALUES ('member-feeds', 'rss', 'Member Feed Sync', 'paused', '{"connector":"feed"}'::jsonb, $1) ON CONFLICT (key) DO NOTHING`, [ORG_A]);
    await db.query(`UPDATE import_sources SET config = config || $1::jsonb WHERE key = 'member-feeds'`, [JSON.stringify({ feeds: [
      { url: 'https://member-m.example.com/events.ics', type: 'ical', organization_id: ORG_M, organizer_name: 'Member M', consent },
      { url: 'https://revoked.example.com/x.ics', organization_id: ORG_M, organizer_name: 'Member M', consent, revoked_at: '2026-10-10' }] })]);
    const mig = require('../scripts/migrate-member-feeds-to-discovery');
    const p = await mig.plan(db);
    expect(p.moves).toHaveLength(1);
    expect(p.skipped).toEqual([expect.objectContaining({ reason: expect.stringMatching(/revoked/) })]);
    await mig.apply(db, p);
    const a = (await db.query(`SELECT * FROM authorized_event_sources WHERE organization_id = $1`, [ORG_M])).rows[0];
    expect(new Date(a.authorized_at).toISOString()).toBe(consent.granted_at);       // never re-dated
    expect(a.authorization_evidence.member_feed_consent).toEqual(consent);
    expect((await db.query(`SELECT kind, status FROM event_collection_channels WHERE authorization_id = $1`, [a.id])).rows).toEqual([{ kind: 'ical', status: 'previewed' }]);
    const mf = (await db.query(`SELECT status, health_state, config FROM import_sources WHERE key = 'member-feeds'`)).rows[0];
    expect(mf).toMatchObject({ status: 'disabled', health_state: 'RETIRED' });
    expect(mf.config.retired_reason).toMatch(/unified/);
    expect(await mig.apply(db, await mig.plan(db))).toMatchObject({ moved: 1 });     // re-running is harmless (no duplicates)
    expect(Number((await db.query(`SELECT count(*)::int n FROM authorized_event_sources WHERE organization_id = $1`, [ORG_M])).rows[0].n)).toBe(1);
  });
});

// ── I ────────────────────────────────────────────────────────────────────────────────────────
describe('I. the report', () => {
  test('one concise report lists every company with who acts', async () => {
    const a = await oversight.assess(db);
    const r = oversight.buildReport(a);
    expect(r.text).toMatch(/Partner A Auctions/);
    expect(r.text).toMatch(/Partner C Estate Sales/);
    expect(r.text).toMatch(/Needs you:/);
    expect(a.findings.filter((f) => f.code === 'OVERSIGHT_INCOMPLETE')).toEqual([]);
  });
});
