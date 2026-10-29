'use strict';

/**
 * Lewis & Maese restoration prep (2026-10-29): fixes that any member feed and the directory sync need,
 * found while planning the Lewis & Maese restoration. Nothing here is specific to one company.
 *
 *   1. A feed item's PUBLICATION date is never used as its event date (a WordPress post feed announcing an
 *      estate sale would otherwise be misdated); an item without an event date is held for review.
 *   2. Directory websites stored form-encoded are decoded at the source, and a one-time, audited,
 *      dry-run-first correction fixes the rows already stored (claimed listings are not rewritten by the sync).
 *   3. Events a RETIRED source brought in can be attributed to the company that held them, through the
 *      existing audited attribution service, dry run first, never overwriting a different host.
 *   4. The oversight alert for a former partner keeps the same key after that attribution (no duplicate alert).
 */

const path = require('path');
const { Worker } = require('worker_threads');

jest.mock('../src/services/eventImport/http', () => ({ fetchText: jest.fn(), fetchJson: jest.fn(), DEFAULT_UA: 'AdvantageBidBot/1.0' }));
const feed = require('../src/services/eventImport/connectors/feedConnector');
const bd = require('../src/services/bdDirectoryService');
const websiteFix = require('../scripts/fix-org-website-encoding');
const retiredAttr = require('../scripts/attribute-retired-source-events');
const oversight = require('../src/services/eventImport/partnerOversight');

// ── 1. event dates ──────────────────────────────────────────────────────────────────────────

describe('feed items keep their real event date', () => {
  const rss = (extra) => `<rss><channel><item><title>West University On-Site Estate Sale</title><link>https://partner.example.com/estate</link>
    <guid>post-1</guid><pubDate>Mon, 01 Sep 2026 15:00:00 GMT</pubDate>${extra || ''}</item></channel></rss>`;
  const parse = (x) => [...feed._parsers.parseRss(x)][0].payload;
  test('a post\'s publication date is not its sale date', () => {
    expect(parse(rss()).start_at).toBeNull();
  });
  test('an explicit event date is used', () => {
    expect(parse(rss('<ev:startdate>2026-11-14T15:00:00Z</ev:startdate>')).start_at).toBe('2026-11-14T15:00:00.000Z');
  });
});

// ── 2. directory websites ───────────────────────────────────────────────────────────────────

describe('directory website addresses', () => {
  test('form-encoded values are decoded; real addresses are kept as given; junk is dropped', () => {
    expect(bd.cleanWebsite('https%3A%2F%2Flmauctionco.com%2F')).toBe('https://lmauctionco.com/');
    expect(bd.cleanWebsite('http%3A%2F%2Fwww.example.life')).toBe('http://www.example.life');
    expect(bd.cleanWebsite('https://alpha.example')).toBe('https://alpha.example');
    expect(bd.cleanWebsite('javascript:alert(1)')).toBeNull();
    expect(bd.cleanWebsite('https%3A%2F%2F%E0%A4%A')).toBeNull();
    expect(bd.cleanWebsite('')).toBeNull();
    expect(bd.normalize({ company: 'X', website: 'https%3A%2F%2Fx.example%2F' }).website).toBe('https://x.example/');
  });
});

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}

describe('one-time corrections on real Postgres', () => {
  let pg, db;
  const LM = '77c403f5-0c8c-4a5e-824a-cf113beb5217';
  const IMPORTER = 'a9a2f8c6-5929-4335-a453-ffef96270e5c';
  const OTHER = '88888888-8888-4888-8888-888888888888';
  beforeAll(async () => {
    pg = startPg();
    const query = async (sql, params) => ({ rows: (await pg.query(sql, params)).rows });
    db = { query, connect: async () => ({ query, release: () => {} }) };
    await pg.exec(`
      CREATE TABLE organizations (id uuid PRIMARY KEY, name text, lifecycle_state text, website_url text, updated_at timestamptz);
      CREATE TABLE audit_log (id serial PRIMARY KEY, event_type text, entity_type text, entity_id uuid, actor_id uuid, metadata jsonb, created_at timestamptz DEFAULT now());
      CREATE TABLE import_sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE, name text, config jsonb DEFAULT '{}');
      CREATE TABLE events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, start_at timestamptz, organizer_name text, organization_id uuid, host_organization_id uuid);
      CREATE TABLE event_sources (event_id uuid, source_id uuid);`);
    await pg.query(`INSERT INTO organizations (id, name, lifecycle_state, website_url) VALUES
      ($1, 'Lewis & Maese Antiques & Auctions', 'claimed', 'https%3A%2F%2Flmauctionco.com%2F'),
      ($2, 'Advantage Auction Company', 'claimed', 'https://advantage.bid'),
      ($3, 'Broken Listing', 'shell', 'https%3A%2F%2F%E0%A4%A')`, [LM, IMPORTER, OTHER]);
  }, 60000);
  afterAll(async () => { if (pg) await pg.close(); });

  test('website correction: dry run first, then decodes only the encoded rows, each audited', async () => {
    const p = await websiteFix.plan(db);
    expect(p.map((c) => [c.name, c.to])).toEqual([['Broken Listing', null], ['Lewis & Maese Antiques & Auctions', 'https://lmauctionco.com/']]);
    expect((await pg.query(`SELECT website_url FROM organizations WHERE id = $1`, [LM])).rows[0].website_url).toBe('https%3A%2F%2Flmauctionco.com%2F'); // plan wrote nothing
    expect(await websiteFix.apply(db, p)).toEqual([LM]);
    expect((await pg.query(`SELECT website_url FROM organizations WHERE id = $1`, [LM])).rows[0].website_url).toBe('https://lmauctionco.com/');
    expect((await pg.query(`SELECT website_url FROM organizations WHERE id = $1`, [OTHER])).rows[0].website_url).toBe('https%3A%2F%2F%E0%A4%A');
    const audit = (await pg.query(`SELECT entity_id, metadata FROM audit_log WHERE event_type = 'organization.website_url_decoded'`)).rows;
    expect(audit).toEqual([{ entity_id: LM, metadata: expect.objectContaining({ from: 'https%3A%2F%2Flmauctionco.com%2F', to: 'https://lmauctionco.com/' }) }]);
    expect(await websiteFix.apply(db, p)).toEqual([]);                            // idempotent: nothing left to change
  });

  test('retired-source attribution: refuses a live source, lists what it would do, records only with evidence', async () => {
    const RET = (await pg.query(`INSERT INTO import_sources (key, name, config) VALUES ('old-lm', 'Retired L&M connector', '{"retired_reason":"member neutrality"}') RETURNING id`)).rows[0].id;
    await pg.query(`INSERT INTO import_sources (key, name) VALUES ('live-src', 'Live')`);
    const ids = [];
    for (const [t, host] of [['Fine Art & Antiques Auction', null], ['West University Estate Sale', null], ['Someone Else Sale', OTHER]]) {
      const id = (await pg.query(`INSERT INTO events (title, start_at, organizer_name, organization_id, host_organization_id) VALUES ($1, now(), 'Lewis & Maese', $2, $3) RETURNING id`, [t, IMPORTER, host])).rows[0].id;
      await pg.query(`INSERT INTO event_sources (event_id, source_id) VALUES ($1, $2)`, [id, RET]); ids.push(id);
    }
    expect((await retiredAttr.plan(db, { source: 'live-src', org: LM })).reason).toMatch(/not a retired source/);
    const p = await retiredAttr.plan(db, { source: 'old-lm', org: LM });
    expect(p.to_attribute.map((e) => e.title)).toEqual(['Fine Art & Antiques Auction', 'West University Estate Sale']);
    expect(p.other_host.map((e) => e.title)).toEqual(['Someone Else Sale']);    // never overwritten
    await expect(retiredAttr.apply(p, { evidence: ' ' })).rejects.toThrow(/evidence is required/);
    const calls = [];
    const done = await retiredAttr.apply(p, { evidence: 'imported from lmauctionco.com by the retired connector', actorId: null,
      attribute: async (...a) => { calls.push(a); } });
    expect(done).toEqual([ids[0], ids[1]]);
    expect(calls.every(([, org, o]) => org === LM && o.method === 'admin_verified' && /retired connector/.test(o.evidence))).toBe(true);
    expect((await pg.query(`SELECT count(*)::int n FROM events WHERE host_organization_id IS NOT NULL AND host_organization_id <> $1`, [OTHER])).rows[0].n).toBe(0); // plan/apply via injection wrote nothing itself
  });
});

// ── 4. stable alert key ──────────────────────────────────────────────────────────────────────

describe('former-partner alert key', () => {
  test('is the same before and after the past events are attributed to the partner', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const row = { source_name: 'Old', organizer_name: 'Lewis & Maese', last_event: '2026-10-15T04:59:00Z' };
    const none = { orgIds: new Set(), names: [] };
    const key = (r) => oversight.ownerActions({ findings: oversight.assessFormerPartners([r], none, now) })[0].key;
    expect(key({ ...row, host_organization_id: null })).toBe(key({ ...row, host_organization_id: '77c403f5-0c8c-4a5e-824a-cf113beb5217' }));
    expect(key({ ...row, host_organization_id: null })).toBe('FORMER_SOURCE_PARTNER:lewismaese');
  });
});
