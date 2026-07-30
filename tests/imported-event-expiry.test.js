'use strict';

// Commit 13 — expire imported events across the four public surfaces + 410 Gone.
// Gated to source='imported' ONLY: org/admin events keep today's behavior.
//   1. GET /api/public/events/:slug  — ended → minimal 200; source-removed → 410
//   2. shareMetaService.getEventMeta — ended imported → null (no rich OG/JSON-LD)
//   3. shareMeta middleware          — ended/removed imported → robots noindex,follow
//   4. getSitemapEntries().events    — ended imported dropped from the sitemap
// Hermetic where DB is involved: the db module is mocked (no real DB is touched).

jest.mock('../src/db', () => ({ query: jest.fn() }));

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const db = require('../src/db');
const svc = require('../src/services/shareMetaService');
const mw = require('../src/middleware/shareMeta');

const SLUG = 'houston-heights-estate-sale-9f2a10bc';

beforeAll(() => { process.env.PUBLIC_BASE_URL = 'https://bid.advantage.bid'; });
beforeEach(() => { db.query.mockReset(); });

// ── Surface 2/3 helper — getEventExpiryState (functional) ────────────────────
describe('shareMetaService.getEventExpiryState', () => {
  test("source-removed wins → 'removed'", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ expired: false, removed: true }] });
    expect(await svc.getEventExpiryState(SLUG)).toBe('removed');
  });
  test("ended imported (not removed) → 'expired'", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ expired: true, removed: false }] });
    expect(await svc.getEventExpiryState(SLUG)).toBe('expired');
  });
  test('active event → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ expired: false, removed: false }] });
    expect(await svc.getEventExpiryState(SLUG)).toBeNull();
  });
  test('unknown slug (no rows) → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await svc.getEventExpiryState(SLUG)).toBeNull();
  });
  test('DB error (e.g. event_sources absent pre-migration) → null, fail-safe', async () => {
    db.query.mockRejectedValueOnce(new Error('relation "event_sources" does not exist'));
    expect(await svc.getEventExpiryState(SLUG)).toBeNull();
  });
  test('invalid slug → null WITHOUT querying', async () => {
    expect(await svc.getEventExpiryState('bad slug!!')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ── Surface 2 — getEventMeta expiry gate (source) ────────────────────────────
describe('getEventMeta excludes ended imported events (Surface 2)', () => {
  const src = read('src', 'services', 'shareMetaService.js');
  test('WHERE excludes ended imported events from rich meta', () => {
    const q = src.slice(src.indexOf('async function getEventMeta'), src.indexOf('async function getEventExpiryState'));
    expect(q).toMatch(/NOT \(e\.source = 'imported' AND e\.end_at IS NOT NULL AND e\.end_at < now\(\)\)/);
  });
});

// ── Surface 4 — sitemap drops ended imported events (source) ─────────────────
describe('getSitemapEntries drops ended imported events (Surface 4)', () => {
  const src = read('src', 'services', 'shareMetaService.js');
  test('events sitemap query excludes ended imported events', () => {
    const q = src.slice(src.indexOf('async function getSitemapEntries'), src.length);
    expect(q).toMatch(/NOT \(e\.source = 'imported' AND e\.end_at IS NOT NULL AND e\.end_at < now\(\)\)/);
  });
  test('org/admin events (incl. ended) are still listed — gate is imported-only', () => {
    const q = read('src', 'services', 'shareMetaService.js');
    // The only expiry exclusion is guarded by source='imported'; no unconditional end_at filter.
    expect(q).not.toMatch(/FROM events e\s+WHERE e\.status = 'published' AND e\.slug IS NOT NULL\s+AND e\.end_at/);
  });
});

// ── Surface 3 — middleware emits noindex for ended/removed imported events ────
function run(req) {
  return new Promise((resolve) => {
    const res = {
      _headers: {}, _body: null,
      set(k, v) { this._headers[k] = v; return this; },
      send(b) { this._body = b; resolve({ res, nextCalled: false }); },
    };
    const next = () => resolve({ res, nextCalled: true });
    Promise.resolve(mw(req, res, next));
  });
}

describe('shareMeta middleware — imported lifecycle noindex (Surface 3)', () => {
  afterEach(() => { if (svc.getEventExpiryState.mockRestore) svc.getEventExpiryState.mockRestore(); });

  test("ended imported → serves robots noindex,follow, no entity block", async () => {
    jest.spyOn(svc, 'getEventExpiryState').mockResolvedValueOnce('expired');
    const r = await run({ method: 'GET', path: '/event.html', query: { slug: SLUG } });
    expect(r.nextCalled).toBe(false);
    expect(r.res._body).toMatch(/<meta name="robots" content="noindex,follow" \/>/);
    // No entity meta injected (the SPA renders the ended state from the API).
    expect(r.res._body).not.toMatch(/share-meta: server-injected/);
    expect(r.res._headers['Cache-Control']).toBe('no-store');
  });

  test('source-removed imported → also noindex,follow', async () => {
    jest.spyOn(svc, 'getEventExpiryState').mockResolvedValueOnce('removed');
    const r = await run({ method: 'GET', path: '/event.html', query: { slug: SLUG } });
    expect(r.nextCalled).toBe(false);
    expect(r.res._body).toMatch(/content="noindex,follow"/);
  });

  test('active imported/org event → normal indexable path (no forced noindex)', async () => {
    jest.spyOn(svc, 'getEventExpiryState').mockResolvedValueOnce(null);
    jest.spyOn(svc, 'getEventMeta').mockResolvedValueOnce(null); // null meta → static fallback
    const r = await run({ method: 'GET', path: '/event.html', query: { slug: SLUG } });
    expect(r.nextCalled).toBe(true); // fell through to static, not the noindex short-circuit
    svc.getEventMeta.mockRestore();
  });
});

// ── Surface 1 — public detail route (source) ─────────────────────────────────
describe('GET /api/public/events/:slug — imported lifecycle (Surface 1)', () => {
  const pub = read('src', 'routes', 'publicEvents.js');
  const block = pub.slice(pub.indexOf("if (r.source === 'imported')"), pub.indexOf('const images = (await db.query'));

  test('source-removed imported → 410 Gone', () => {
    expect(block).toMatch(/status\(410\)/);
    expect(block).toMatch(/EVENT_REMOVED/);
    expect(block).toMatch(/sync_status = 'removed'/);
    // multi-source-safe: removed only when NO source row is still active
    expect(block).toMatch(/NOT EXISTS \(SELECT 1 FROM event_sources es2/);
  });

  test('removed probe fails safe (not-removed) when event_sources is absent', () => {
    expect(block).toMatch(/catch \(e\) \{ removed = false; \}/);
  });

  test('ended imported → minimal 200 payload (no third-party content)', () => {
    const payload = block.slice(block.indexOf('expired: true'), block.indexOf('expired: true') + 120);
    expect(payload).toMatch(/expired: true/);
    expect(payload).toMatch(/slug: r\.slug/);
    expect(payload).toMatch(/city: r\.city/);
    expect(payload).toMatch(/state: r\.state/);
    // NEVER leak title/description/images/urls after expiry
    expect(payload).not.toMatch(/title|description|images|external_url|registration_url|bidding_url|organizer/);
  });

  test('gate is imported-only (org/admin events unaffected)', () => {
    expect(block.indexOf("if (r.source === 'imported')")).toBe(0);
  });
});

// ── Frontend — event.html renders ended/gone states, never redirects ─────────
describe('event.html — ended + removed states keep the visitor on Advantage.Bid', () => {
  const html = read('public', 'event.html');

  test('handles 410 Gone with a "no longer available" state', () => {
    expect(html).toMatch(/r\.status === 410/);
    expect(html).toMatch(/function renderGone/);
    expect(html).toMatch(/no longer available/);
  });

  test('handles the minimal expired payload with a "sale has ended" state', () => {
    expect(html).toMatch(/res\.data\.expired/);
    expect(html).toMatch(/function renderExpired/);
    expect(html).toMatch(/This sale has ended/);
  });

  test('ended/gone states still show internal breadcrumbs + related active events', () => {
    expect(html).toMatch(/function crumbsHtml/);
    expect(html).toMatch(/renderExpired[\s\S]*loadRelated\(\)/);
  });

  test('NEVER auto-redirects off Advantage.Bid, even on expiry', () => {
    expect(html).not.toMatch(/location\.href\s*=/);
    expect(html).not.toMatch(/location\.replace/);
    expect(html).not.toMatch(/window\.location\s*=/);
    expect(html).not.toMatch(/http-equiv=["']refresh/i);
  });
});
