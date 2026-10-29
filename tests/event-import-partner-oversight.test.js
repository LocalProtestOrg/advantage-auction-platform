'use strict';

/**
 * Approved-partner event imports and the Marketing Director's oversight (owner assignment 2026-10-29).
 *
 *   1. Member Feed Sync: auctions and estate sales are classified from what each item says; a member's
 *      declared sale type and time zone apply; every item is attributed to the consenting member.
 *   2. Each partner's own result is recorded (a refused, broken or missing feed is visible per partner,
 *      never hidden inside a source that "succeeded"), and nothing is parsed out of a refusal page.
 *   3. Repeated syncs update the same events (stable ids), never duplicate them.
 *   4. A recoverable failure of one partner's feed gets the same bounded automatic retry.
 *   5. Oversight findings: who acts (automatic / admin review / investigate / owner) and what they do.
 *   6. The oversight SQL runs on real Postgres; history rows alert each new problem once.
 *   7. The Marketing Director holds the duty and none of the forbidden powers; the module is read-only.
 *
 * Fixtures use example.com partners: no real partner event is invented here.
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

jest.mock('../src/services/eventImport/http', () => {
  const actual = jest.requireActual('../src/services/eventImport/http');
  return { fetchText: jest.fn(), fetchJson: jest.fn(), DEFAULT_UA: actual.DEFAULT_UA };
});
const http = require('../src/services/eventImport/http');
const feed = require('../src/services/eventImport/connectors/feedConnector');
const diagnostics = require('../src/services/eventImport/diagnostics');
const sourceHealth = require('../src/services/eventImport/sourceHealth');
const memberFeeds = require('../src/services/eventImport/memberFeedService');
const oversight = require('../src/services/eventImport/partnerOversight');
const agents = require('../src/constants/marketingAgents');
const { runImport } = require('../src/services/eventImport/index');

const ORG = '22222222-2222-4222-8222-222222222222';
const PARTNER = { organization_id: ORG, organizer_name: 'Example Partner Auctions', organizer_website_url: 'https://partner.example.com',
  consent: { granted_by: 'Owner of Example Partner Auctions', granted_at: '2026-10-01T00:00:00Z', evidence: 'signed authorization form (test fixture)' } };
const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };

// A partner calendar with one auction and one estate sale, local (floating) times in the partner's zone.
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:auction-1@partner.example.com', 'SUMMARY:Fall Fine Art Auction', 'DTSTART:20261107T100000', 'DTEND:20261107T180000',
  'LOCATION:123 Main St, Houston, TX 77055', 'URL:https://partner.example.com/auctions/fall', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:estate-1@partner.example.com', 'SUMMARY:West University On-Site Estate Sale', 'DTSTART:20261114T090000', 'DTEND:20261114T150000',
  'LOCATION:456 Oak St, Houston, TX 77005', 'URL:https://partner.example.com/estate-sales/west-u', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:other-1@partner.example.com', 'SUMMARY:Holiday Open House', 'DTSTART:20261121T100000',
  'LOCATION:123 Main St, Houston, TX 77055', 'URL:https://partner.example.com/open-house', 'END:VEVENT',
  'END:VCALENDAR'].join('\r\n');

beforeEach(() => { http.fetchText.mockReset(); });

// ── 1. classification, time zone and attribution ─────────────────────────────────────────────

describe('Member Feed Sync: auctions and estate sales', () => {
  const { classifySaleType } = feed._parsers;
  test('an item is classified only from what it says itself', () => {
    expect(classifySaleType('West University On-Site Estate Sale')).toBe('estate_sale');
    expect(classifySaleType('Fall Fine Art Auction')).toBe('auction');
    expect(classifySaleType('L&M Estate Auction')).toBe('auction');              // an estate AUCTION is an auction
    expect(classifySaleType('Tag Sale this weekend')).toBe('estate_sale');
    expect(classifySaleType('Estate Sale and Online Auction')).toBeNull();       // says both: not guessed
    expect(classifySaleType('Holiday Open House')).toBeNull();                   // says neither
    expect(classifySaleType('Spring Preview', 'Auctions')).toBe('auction');      // a category counts
  });

  test('a consented partner calendar yields an auction and an estate sale, attributed to the partner, in its own time zone', async () => {
    http.fetchText.mockResolvedValue({ ok: true, status: 200, text: ICS, contentType: 'text/calendar' });
    const out = await collect(feed.fetch({ config: { feeds: [{ url: 'https://partner.example.com/events.ics', ...PARTNER, timezone: 'America/Chicago' }] } }));
    expect(out).toHaveLength(3);
    const [auction, estate, other] = out;
    expect(auction.payload.sale_type).toBe('auction');
    expect(estate.payload.sale_type).toBe('estate_sale');
    expect(other.payload.sale_type).toBeUndefined();                              // held for review, never guessed
    expect(out.every((x) => x.memberOrganizationId === ORG && x.payload.organizer_name === 'Example Partner Auctions')).toBe(true);
    expect(auction.payload.start_at).toBe('2026-11-07T16:00:00.000Z');           // 10:00 in Houston (CST)
    expect(auction.payload.timezone).toBe('America/Chicago');
    expect(auction.sourceUrl).toBe('https://partner.example.com/auctions/fall');
  });

  test('the member\'s declared sale type applies only when an item does not say', async () => {
    http.fetchText.mockResolvedValue({ ok: true, status: 200, text: ICS, contentType: 'text/calendar' });
    const out = await collect(feed.fetch({ config: { feeds: [{ url: 'https://partner.example.com/events.ics', ...PARTNER, sale_type: 'estate_sale' }] } }));
    expect(out.map((x) => x.payload.sale_type)).toEqual(['auction', 'estate_sale', 'estate_sale']);
  });

  test('onboarding accepts a declared sale type and time zone, and refuses invalid ones', () => {
    const base = { url: 'https://partner.example.com/events.ics', organizationId: ORG, organizerName: 'P', consent: PARTNER.consent };
    expect(memberFeeds.buildFeed({ ...base, saleType: 'auction', timezone: 'America/Chicago' }).feed).toMatchObject({ sale_type: 'auction', timezone: 'America/Chicago' });
    expect(memberFeeds.buildFeed({ ...base, saleType: 'garage' }).reason).toMatch(/saleType/);
    expect(memberFeeds.buildFeed({ ...base, timezone: 'Mars/Olympus' }).reason).toMatch(/time zone/);
    expect(memberFeeds.buildFeed(base).feed.sale_type).toBeUndefined();
  });
});

// ── 2. per-partner results ───────────────────────────────────────────────────────────────────

describe('each partner\'s own result is recorded', () => {
  const run = async (feeds) => { const diag = diagnostics.createDiagnostics(); const out = await collect(feed.fetch({ config: { feeds }, diag })); return { out, partners: diag.partners(), diag }; };
  const A = { url: 'https://a.example.com/events.ics', ...PARTNER, organization_id: '33333333-3333-4333-8333-333333333333', organizer_name: 'Partner A' };
  const B = { url: 'https://b.example.com/events.ics', ...PARTNER, organization_id: '44444444-4444-4444-8444-444444444444', organizer_name: 'Partner B' };

  test('one partner refusing access is visible even though the other synced', async () => {
    http.fetchText.mockImplementation(async (url) => (url.startsWith('https://a.')
      ? { ok: false, status: 403, text: '<title>Access Denied</title><script type="application/ld+json">{"@type":"Event","name":"x","url":"https://a.example.com/x"}</script>' }
      : { ok: true, status: 200, text: ICS, contentType: 'text/calendar' }));
    const { out, partners } = await run([A, B]);
    expect(out).toHaveLength(3);                                                  // nothing is read out of the refusal page
    expect(partners).toEqual([
      expect.objectContaining({ organizer_name: 'Partner A', outcome: 'blocked', http: 403, items: 0 }),
      expect.objectContaining({ organizer_name: 'Partner B', outcome: 'ok', http: 200, items: 3 }),
    ]);
  });
  test('a page that loads but is not a feed is a format change, not an empty calendar', async () => {
    http.fetchText.mockResolvedValue({ ok: true, status: 200, text: '<html><body>We have moved!</body></html>', contentType: 'text/html' });
    expect((await run([{ ...A, type: 'ical' }])).partners[0].outcome).toBe('parse_failure');
  });
  test('a readable calendar with nothing on it is an empty feed', async () => {
    http.fetchText.mockResolvedValue({ ok: true, status: 200, text: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', contentType: 'text/calendar' });
    expect((await run([A])).partners[0].outcome).toBe('empty');
  });
  test('a partner site with no feed on it says so', async () => {
    http.fetchText.mockResolvedValue({ ok: true, status: 200, text: '<html><head><title>Home</title></head></html>', contentType: 'text/html', url: 'https://a.example.com/' });
    const { partners } = await run([{ site: 'https://a.example.com/', ...PARTNER }]);
    expect(partners[0]).toMatchObject({ outcome: 'no_feed_found', items: 0 });
  });
  test('a refused partner site is never searched for feeds', async () => {
    http.fetchText.mockResolvedValue({ ok: false, status: 403, text: '<link rel="alternate" type="text/calendar" href="/cal.ics">' });
    const { partners } = await run([{ site: 'https://a.example.com/', ...PARTNER }]);
    expect(http.fetchText).toHaveBeenCalledTimes(1);
    expect(partners[0]).toMatchObject({ outcome: 'blocked', http: 403 });
  });
  test('a feed that keeps answering 429 is recorded as rate limited', async () => {
    http.fetchText.mockRejectedValue(new Error('HTTP 429'));
    expect((await run([A])).partners[0]).toMatchObject({ outcome: 'rate_limited', http: 429 });
  });
  test('the importer always identifies itself honestly (no browser identity anywhere in the feed path)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/eventImport/connectors/feedConnector.js'), 'utf8');
    expect(src).not.toMatch(/User-Agent|Mozilla|BROWSER_UA|ua:/);
  });
});

// ── 3. repeated syncs update, never duplicate ────────────────────────────────────────────────

describe('repeated syncs', () => {
  function fakeDb({ existing = null } = {}) {
    return {
      query: async (sql) => {
        if (/FROM import_sources WHERE key/.test(sql)) {
          return { rows: [{ id: 'src-mf', key: 'member-feeds', kind: 'rss', name: 'Member Feed Sync', status: 'active', weekly_cap: 75,
            config: { connector: 'feed', feeds: [{ url: 'https://partner.example.com/events.ics', ...PARTNER, timezone: 'America/Chicago', inlineHtml: ICS, type: 'ical' }] } }] };
        }
        if (/FROM event_sources WHERE source_id=\$1 AND source_event_id=\$2/.test(sql)) return { rows: existing ? [existing] : [] };
        return { rows: [] };
      },
      withTransaction: async (cb) => cb({ query: async () => ({ rows: [] }) }),
    };
  }
  test('the same calendar read twice matches the same events by their stable ids', async () => {
    const first = await runImport({ sourceKey: 'member-feeds', db: fakeDb(), apply: false, nowMs: Date.parse('2026-10-29T12:00:00Z') });
    const ids = first.items.map((i) => i.sourceEventId);
    expect(ids).toEqual(['auction-1@partner.example.com', 'estate-1@partner.example.com', 'other-1@partner.example.com']);
    expect(first.partners).toEqual([expect.objectContaining({ outcome: 'ok', items: 3 })]);
    const again = await runImport({ sourceKey: 'member-feeds', db: fakeDb({ existing: { event_id: 'EV-1', content_hash: 'different', images_hash: null } }),
      apply: false, nowMs: Date.parse('2026-10-29T12:00:00Z') });
    expect(again.items.filter((i) => i.outcome === 'created')).toHaveLength(0);   // matched, not created again
    expect(again.items.some((i) => i.outcome === 'updated' && i.eventId === 'EV-1')).toBe(true);
  });
});

// ── 4. bounded retry ─────────────────────────────────────────────────────────────────────────

describe('a recoverable failure of one partner feed', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  test('schedules the bounded retry without counting the run as failed', () => {
    const s = sourceHealth.nextState({}, { ok: true, status: 'completed', fetched: 3, partial_transient: true, trigger: 'scheduled' }, now);
    expect(s.consecutive_failures).toBe(0);
    expect(s.next_retry_at).toBe('2026-10-29T13:00:00.000Z');
  });
  test('stops after the retry budget', () => {
    const s = sourceHealth.nextState({ retry_count: sourceHealth.MAX_RETRIES - 1 }, { ok: true, status: 'completed', fetched: 3, partial_transient: true, trigger: 'retry' }, now);
    expect(s.next_retry_at).toBeNull();
  });
  test('a refusal or format change is never retried automatically', () => {
    expect(diagnostics.TRANSIENT_FEED_OUTCOMES).toEqual(['rate_limited', 'unreachable']);
  });
});

// ── 5. findings: who acts, and what they do ──────────────────────────────────────────────────

describe('oversight findings', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  const ctx = { sourceActive: true, now };
  const feedRow = { url: 'https://partner.example.com/events.ics', ...PARTNER };
  const ok = (daysAgo, items) => ({ at: new Date(now - daysAgo * 864e5).toISOString(), outcome: items ? 'ok' : 'empty', http: 200, items });
  const codes = (f) => f.map((x) => x.code + ':' + x.owner);

  test('no consent: the feed is not fetched and a person must record consent', () => {
    const f = oversight.assessFeed({ url: feedRow.url, organization_id: ORG, organizer_name: 'P' }, [], {}, ctx);
    expect(codes(f)).toEqual(['CONSENT_MISSING:owner']);
  });
  test('consented but Member Feed Sync is paused: activation needs approval', () => {
    expect(codes(oversight.assessFeed(feedRow, [], {}, { sourceActive: false, now }))).toContain('SYNC_PAUSED:owner');
  });
  test('a refusal names exactly what the partner\'s website administrator must allow', () => {
    const [b] = oversight.assessFeed(feedRow, [{ at: now.toISOString(), outcome: 'blocked', http: 403, items: 0 }], {}, ctx);
    expect(b).toMatchObject({ code: 'BLOCKED', owner: 'owner', http: 403 });
    expect(b.action).toContain(http.DEFAULT_UA);
    expect(b.action).toMatch(/iCal|RSS|JSON-LD/);
  });
  test('a format change asks for a technical repair', () => {
    expect(codes(oversight.assessFeed(feedRow, [{ at: now.toISOString(), outcome: 'parse_failure', http: 200, items: 0 }], {}, ctx))).toContain('FORMAT_CHANGED:owner');
  });
  test('recoverable failures retry automatically, then escalate after three in a row', () => {
    const fail = { at: now.toISOString(), outcome: 'unreachable', http: 503, items: 0 };
    expect(codes(oversight.assessFeed(feedRow, [fail, ok(2, 3)], { upcoming: 3 }, ctx))).toEqual(['RETRYING:automatic']);
    expect(codes(oversight.assessFeed(feedRow, [fail, fail, fail, ok(2, 3)], { upcoming: 3 }, ctx))).toContain('FAILING:owner');
  });
  test('no good sync for over eight days is stale', () => {
    expect(codes(oversight.assessFeed(feedRow, [ok(9, 3)], { upcoming: 3 }, ctx))).toContain('STALE:owner');
  });
  test('an unusual drop in listed events is worth a look, not an alarm', () => {
    expect(codes(oversight.assessFeed(feedRow, [ok(0, 1), ok(3, 8)], { upcoming: 1, discoverable: 1 }, ctx))).toEqual(['COUNT_DROP:investigate']);
  });
  test('a partner with nothing upcoming is investigated, not assumed to have failed', () => {
    const f = oversight.assessFeed(feedRow, [ok(0, 0)], { upcoming: 0 }, ctx);
    expect(codes(f)).toEqual(['NO_UPCOMING:investigate']);
    expect(f[0].action).toMatch(/nothing scheduled/);
  });
  test('imported events that are not public, unclassified, misdated, off-site or duplicated are each flagged', () => {
    const f = oversight.assessFeed(feedRow, [ok(0, 5)], { upcoming: 5, discoverable: 1, awaiting_review: 2, other_unpublished: 1, unclassified: 1,
      bad_dates: 1, missing_link: 1, off_site_links: 1, duplicates: 1 }, ctx);
    expect(codes(f)).toEqual(['AWAITING_REVIEW:admin_review', 'NOT_DISCOVERABLE:investigate', 'UNCLASSIFIED:investigate', 'BAD_DATES:investigate',
      'MISSING_LINK:investigate', 'OFF_SITE_LINKS:investigate', 'DUPLICATES:investigate']);
  });
  test('a healthy partner produces no findings', () => {
    expect(oversight.assessFeed(feedRow, [ok(0, 2), ok(3, 2)], { upcoming: 2, discoverable: 2 }, ctx)).toEqual([]);
  });
  test('live sources: blocked, broken, retrying, stale and dropping', () => {
    const base = { key: 'gov', name: 'Gov', live: true, health_state: 'HEALTHY', last_success_at: now.toISOString() };
    expect(codes(oversight.assessSource({ ...base, health_state: 'BLOCKED_BY_SOURCE', health_reason: 'x' }, [], now))).toEqual(['SOURCE_BLOCKED:owner']);
    expect(codes(oversight.assessSource({ ...base, health_state: 'BROKEN', health_reason: 'x' }, [], now))).toEqual(['SOURCE_BROKEN:owner']);
    expect(codes(oversight.assessSource({ ...base, health_state: 'DEGRADED', health_reason: 'x', next_retry_at: now.toISOString() }, [], now))).toEqual(['SOURCE_RETRYING:automatic']);
    expect(codes(oversight.assessSource({ ...base, last_success_at: '2026-10-10T00:00:00Z' }, [], now))).toEqual(['SOURCE_STALE:owner']);
    expect(codes(oversight.assessSource(base, [{ status: 'completed', fetched: 10 }, { status: 'completed', fetched: 57 }], now))).toEqual(['SOURCE_COUNT_DROP:investigate']);
    expect(oversight.assessSource({ ...base, live: false, health_state: 'RETIRED' }, [], now)).toEqual([]);
  });
  test('former-source partners: reported within the window, unless a current path covers them', () => {
    const row = { source_name: 'Old Connector', retired_at: '2026-09-24T18:05:44Z', organizer_name: 'Lewis & Maese', host_organization_id: null, last_event: '2026-10-15T04:59:00Z' };
    const none = { orgIds: new Set(), names: [] };
    expect(codes(oversight.assessFormerPartners([row], none, now))).toEqual(['FORMER_SOURCE_PARTNER:owner']);
    expect(oversight.assessFormerPartners([{ ...row, last_event: new Date('2026-10-15T04:59:00Z') }], none, now)[0].message).toMatch(/until 2026-10-15, which was retired on 2026-09-24/);
    expect(oversight.assessFormerPartners([row], { orgIds: new Set(), names: ['lewismaeseantiquesauctions'] }, now)).toEqual([]);   // its feed is registered
    expect(oversight.assessFormerPartners([{ ...row, last_event: '2026-01-01T00:00:00Z' }], none, now)).toEqual([]);                // long gone: not an action
  });
  test('overall state and the report', () => {
    const a = { generated_at: now.toISOString(), sources: [{ key: 'gov', name: 'Gov', status: 'active', live: true, health_state: 'HEALTHY', last_fetched: 57 }],
      partners: [{ name: 'Example Partner Auctions', events: { upcoming: 0, discoverable: 0 }, last_sync: null, consent: 'missing' }],
      findings: oversight.assessFeed({ url: feedRow.url, organization_id: ORG, organizer_name: 'Example Partner Auctions' }, [], {}, ctx) };
    a.overall = oversight.overallOf(a.findings);
    expect(a.overall).toBe('ACTION_REQUIRED');
    const r = oversight.buildReport(a);
    expect(r.subject).toMatch(/1 needs you/);
    expect(r.text).toMatch(/Needs you:\n- Example Partner Auctions: no complete consent/);
    expect(r.text).not.toMatch(/—/);                                         // no em dashes
    expect(oversight.overallOf([])).toBe('OK');
    expect(oversight.overallOf([{ owner: 'investigate' }])).toBe('ATTENTION');
  });
});

// ── 6. real Postgres ─────────────────────────────────────────────────────────────────────────

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}

describe('oversight on real Postgres', () => {
  let pg, db;
  const SRC = '55555555-5555-4555-8555-555555555555';
  beforeAll(async () => {
    pg = startPg();
    db = { query: async (sql, params) => ({ rows: (await pg.query(sql, params)).rows }) };
    await pg.exec(`
      CREATE TABLE import_sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE, name text, kind text, status text, media_policy text,
        config jsonb NOT NULL DEFAULT '{}', health_state text, health_reason text, consecutive_failures int DEFAULT 0, consecutive_zero_runs int DEFAULT 0,
        last_success_at timestamptz, last_nonzero_at timestamptz, last_failure_at timestamptz, last_error text, next_retry_at timestamptz,
        retry_count int DEFAULT 0, health_updated_at timestamptz);
      CREATE TABLE import_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid, trigger text, status text, fetched int DEFAULT 0,
        eligible int DEFAULT 0, created int DEFAULT 0, updated int DEFAULT 0, skipped_duplicate int DEFAULT 0, skipped_quality int DEFAULT 0,
        skipped_ambiguous int DEFAULT 0, stats jsonb DEFAULT '{}', started_at timestamptz, finished_at timestamptz, last_error text);
      CREATE TABLE events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, status text, sale_type text, start_at timestamptz,
        end_at timestamptz, external_url text, host_organization_id uuid, organization_id uuid, source text, organizer_name text);
      CREATE TABLE event_sources (event_id uuid, source_id uuid);
      CREATE TABLE organizations (id uuid PRIMARY KEY, name text);
      CREATE TABLE audit_log (id serial PRIMARY KEY, event_type text, entity_type text, entity_id uuid, actor_id uuid, metadata jsonb, created_at timestamptz DEFAULT clock_timestamp());`);
    await pg.query(`INSERT INTO import_sources (id, key, name, kind, status, config, health_state, health_reason, last_success_at)
      VALUES ($1, 'member-feeds', 'Member Feed Sync', 'rss', 'active', $2::jsonb, 'HEALTHY', 'ok', now())`,
      [SRC, JSON.stringify({ connector: 'feed', feeds: [{ url: 'https://partner.example.com/events.ics', ...PARTNER }] })]);
    const partners = (outcome, items, http) => JSON.stringify({ partners: [{ organization_id: ORG, feed: 'https://partner.example.com/events.ics', outcome, items, http }] });
    await pg.query(`INSERT INTO import_runs (source_id, status, fetched, stats, started_at) VALUES ($1, 'completed', 0, $2::jsonb, now() - interval '3 days'), ($1, 'completed', 0, $3::jsonb, now())`,
      [SRC, partners('ok', 2, 200), partners('blocked', 0, 403)]);
    await pg.query(`INSERT INTO events (title, status, sale_type, start_at, end_at, external_url, host_organization_id) VALUES
      ('Fall Fine Art Auction', 'published', 'auction', now() + interval '9 days', now() + interval '9 days 8 hours', 'https://partner.example.com/auctions/fall', $1),
      ('West U Estate Sale', 'draft', 'estate_sale', now() + interval '16 days', now() + interval '16 days 6 hours', 'https://partner.example.com/estate', $1),
      ('West U Estate Sale', 'draft', 'estate_sale', now() + interval '16 days', now() + interval '16 days 6 hours', 'https://elsewhere.example.net/x', $1),
      ('Old Sale', 'published', 'estate_sale', now() - interval '20 days', now() - interval '19 days', 'https://partner.example.com/old', $1)`, [ORG]);
  }, 60000);
  afterAll(async () => { if (pg) await pg.close(); });

  test('assess reads sources, partner history and events, and names the blocked partner', async () => {
    const a = await oversight.assess(db);
    expect(a.findings.filter((f) => f.code === 'OVERSIGHT_INCOMPLETE')).toEqual([]);
    const p = a.partners.find((x) => x.organization_id === ORG);
    expect(p).toMatchObject({ kind: 'member_feed', consent: 'recorded', last_sync: expect.objectContaining({ outcome: 'blocked', http: 403 }) });
    expect(p.events).toMatchObject({ upcoming: 3, discoverable: 1, awaiting_review: 2, unclassified: 0, off_site_links: 1, duplicates: 1 });
    expect(a.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['BLOCKED', 'AWAITING_REVIEW', 'OFF_SITE_LINKS', 'DUPLICATES']));
    expect(a.overall).toBe('ACTION_REQUIRED');
  });
  test('a partner whose retired source went quiet is reported until it has a new path (the silent-disappearance case)', async () => {
    const RET = '66666666-6666-4666-8666-666666666666';
    await pg.query(`INSERT INTO import_sources (id, key, name, kind, status, config, health_state)
      VALUES ($1, 'old-member-connector', 'Old Member Connector', 'rest', 'disabled', '{"retired_reason":"member neutrality","retired_at":"2026-09-24T18:05:44Z"}'::jsonb, 'RETIRED')`, [RET]);
    const ev = (await pg.query(`INSERT INTO events (title, status, sale_type, start_at, end_at, organizer_name)
      VALUES ('Past Quiet Partner Auction', 'published', 'auction', now() - interval '15 days', now() - interval '14 days', 'Quiet Partner Co') RETURNING id`)).rows[0].id;
    await pg.query(`INSERT INTO event_sources (event_id, source_id) VALUES ($1, $2)`, [ev, RET]);
    let a = await oversight.assess(db);
    const f = a.findings.find((x) => x.code === 'FORMER_SOURCE_PARTNER');
    expect(f).toMatchObject({ owner: 'owner', partner: 'Quiet Partner Co' });
    expect(f.message).toMatch(/Old Member Connector .* retired on 2026-09-24/);
    expect(a.sources.map((x) => x.key)).not.toContain('old-member-connector');   // a retired source itself is not an action item
    // Once the partner publishes through its member account, it has a path again and is no longer reported.
    const QORG = '77777777-7777-4777-8777-777777777777';
    await pg.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Quiet Partner Co')`, [QORG]);
    await pg.query(`INSERT INTO events (title, status, sale_type, start_at, end_at, organization_id, source)
      VALUES ('Winter Auction', 'published', 'auction', now() + interval '30 days', now() + interval '31 days', $1, 'organization')`, [QORG]);
    a = await oversight.assess(db);
    expect(a.findings.find((x) => x.code === 'FORMER_SOURCE_PARTNER')).toBeUndefined();
    expect(a.findings.filter((x) => x.code === 'OVERSIGHT_INCOMPLETE')).toEqual([]);
  });
  test('the history alerts a standing problem once, and again only if it is new', async () => {
    const a = await oversight.assess(db);
    expect((await oversight.recordAssessment(db, a)).map((x) => x.key)).toEqual(['BLOCKED:' + ORG]);
    expect(await oversight.recordAssessment(db, a)).toEqual([]);
    const rows = (await pg.query(`SELECT metadata FROM audit_log WHERE event_type = 'event_import_oversight' ORDER BY id`)).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].metadata).toMatchObject({ overseer: 'A1', overall: 'ACTION_REQUIRED', action_keys: ['BLOCKED:' + ORG] });
  });
  test('assessment writes nothing but its own history row', async () => {
    const before = (await pg.query(`SELECT md5(string_agg(row_to_json(e)::text, ',' ORDER BY id)) h FROM events e`)).rows[0].h;
    const cfg = (await pg.query(`SELECT config::text c FROM import_sources`)).rows[0].c;
    await oversight.assess(db);
    expect((await pg.query(`SELECT md5(string_agg(row_to_json(e)::text, ',' ORDER BY id)) h FROM events e`)).rows[0].h).toBe(before);
    expect((await pg.query(`SELECT config::text c FROM import_sources`)).rows[0].c).toBe(cfg);
  });
});

// ── 7. the Marketing Director's duty and limits ──────────────────────────────────────────────

describe('Marketing Director oversight duty', () => {
  test('A1 holds the event-import oversight duty; no agent holds a forbidden power', () => {
    expect(agents.agentCan('A1', 'oversee_event_imports')).toBe(true);
    expect(oversight.OVERSEER).toMatchObject({ code: 'A1', capability: 'oversee_event_imports' });
    for (const a of Object.values(agents.AGENTS)) {
      for (const cap of agents.FORBIDDEN_PHASE1_CAPABILITIES) expect([a.code, a.capabilities.includes(cap)]).toEqual([a.code, false]);
    }
    for (const forbidden of ['bypass_source_access', 'impersonate_browser', 'publish_unverified_event', 'record_feed_consent', 'deploy_code']) {
      expect(agents.FORBIDDEN_PHASE1_CAPABILITIES).toContain(forbidden);
    }
    expect(oversight.MUST_NOT).toEqual(expect.arrayContaining(['bypass_source_access', 'create_event', 'publish_event', 'invent_photographs',
      'record_consent', 'change_code', 'deploy']));
  });
  test('the oversight module is read-only: it fetches nothing and writes only its history row', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/eventImport/partnerOversight.js'), 'utf8');
    expect(src).not.toMatch(/fetchText\(|fetchJson\(|runImport|registerFeed|revokeFeed/);
    expect(src).not.toMatch(/\b(UPDATE|DELETE FROM)\b/);
    expect(src.match(/INSERT INTO (\w+)/g)).toEqual(['INSERT INTO audit_log']);
  });
  test('the worker runs oversight from its existing health check and reports through the existing summary email', () => {
    const w = fs.readFileSync(path.join(__dirname, '../src/workers/eventImportWorker.js'), 'utf8');
    expect(w).toMatch(/const oversight = await runPartnerOversight\(nowDate, \{ afterCycle: !!o\.afterCycle, emailOn \}\)/);
    expect(w).toMatch(/partnerOversight\.buildReport\(await partnerOversight\.assess\(db\)\)\.text/);
    expect(w).toMatch(/if \(o\.emailOn && fresh\.length\)/);                     // alerts only new problems, only when import emails are on
  });
});
