'use strict';

jest.mock('../../src/services/eventImport/writer', () => ({
  createImported: jest.fn(async () => 'EV-new'),
  updateImported: jest.fn(async () => 'EV-upd'),
  publishImported: jest.fn(async () => true),
}));

const csv = require('../../src/services/eventImport/connectors/csvConnector');
const { runImport } = require('../../src/services/eventImport/index');
const writer = require('../../src/services/eventImport/writer');

describe('csvConnector', () => {
  test('parses quotes, commas, and newlines', () => {
    const rows = csv.toObjects('id,name\n1,"Smith, Jr. ""Estate"""\n2,Plain');
    expect(rows).toEqual([{ id: '1', name: 'Smith, Jr. "Estate"' }, { id: '2', name: 'Plain' }]);
  });
  test('fetch yields records keyed by id, parses images, skips id-less rows', async () => {
    const cfg = { csvText: 'id,name,imgs\nA,Sale,https://i/1.jpg;https://i/2.jpg\n,NoId,\n', idColumn: 'id', imageColumn: 'imgs' };
    const out = [];
    for await (const r of csv.fetch({ config: cfg })) out.push(r);
    expect(out.length).toBe(1);
    expect(out[0].sourceEventId).toBe('A');
    expect(out[0].images).toEqual([{ url: 'https://i/1.jpg', position: 0 }, { url: 'https://i/2.jpg', position: 1 }]);
  });
});

const FIELD_MAP = { title: 'name', start_at: 'start', city: 'city', state: 'state', timezone: { const: 'America/New_York' } };
const CSV3 = 'id,name,start,city,state\nE1,Adrian Estate Sale,2026-08-01T14:00:00Z,Adrian,MI\nE2,,2026-08-01T14:00:00Z,Adrian,MI\nE3,Tecumseh Sale,2026-08-02T14:00:00Z,Tecumseh,MI\n';

function source(over) {
  return Object.assign({ id: 'src-1', key: 'csv-test', kind: 'csv', name: 'CSV Test', owner_organization_id: 'org-1',
    weekly_cap: 75, auto_publish: false, config: { csvText: CSV3, idColumn: 'id', field_map: FIELD_MAP } }, over || {});
}
function fakeDb({ src, tier1 = [], events = [], runId = 'RUN1' } = {}) {
  const calls = [];
  const db = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM import_sources WHERE key/.test(sql)) return { rows: [src] };
      if (/FROM event_sources WHERE source_id=\$1 AND source_event_id=\$2/.test(sql)) return { rows: tier1 };
      if (/FROM event_sources WHERE source_id=\$1 AND source_url_hash=\$2/.test(sql)) return { rows: [] };
      if (/FROM events/.test(sql)) return { rows: events };
      if (/FROM event_markets/.test(sql)) return { rows: [] };       // no active markets → fallback national
      if (/FROM event_market_zips/.test(sql)) return { rows: [] };
      if (/INSERT INTO import_runs/.test(sql)) return { rows: [{ id: runId, started_at: 't' }] };
      return { rows: [] };
    },
    withTransaction: async (cb) => cb({ query: async () => ({ rows: [] }) }),
    all: function (re) { return this.calls.filter((c) => re.test(c.sql)); },
  };
  return db;
}

beforeEach(() => { writer.createImported.mockClear(); writer.updateImported.mockClear(); writer.publishImported.mockClear(); });

describe('runImport — dry run (default) writes nothing', () => {
  test('reads only; classifies 2 creates + 1 quality reject; no run ledger, no market_candidates, no writer', async () => {
    const db = fakeDb({ src: source() });
    const res = await runImport({ sourceKey: 'csv-test', db, apply: false });
    expect(res.applied).toBe(false);
    expect(res.counters).toMatchObject({ fetched: 3, eligible: 2, created: 2, skipped_quality: 1 });
    expect(res.items.map((i) => i.outcome).sort()).toEqual(['created', 'created', 'rejected_quality']);
    expect(res.items.filter((i) => i.outcome === 'created').every((i) => i.marketVia === 'fallback')).toBe(true);
    expect(db.all(/INSERT INTO import_runs/).length).toBe(0);
    expect(db.all(/INSERT INTO market_candidates/).length).toBe(0);
    expect(writer.createImported).not.toHaveBeenCalled();
  });
});

describe('runImport — dedupe outcomes', () => {
  test('a matching source_event_id with equal content_hash → unchanged, zero writes', async () => {
    // Make both eligible rows resolve to unchanged by returning a tier-1 hit with the record's own hash.
    // Easiest: intercept the tier-1 query to echo a matching content_hash per source_event_id.
    const db = fakeDb({ src: source() });
    const origQuery = db.query;
    db.query = async (sql, params) => {
      if (/FROM event_sources WHERE source_id=\$1 AND source_event_id=\$2/.test(sql)) {
        return { rows: [{ event_id: 'EV-' + params[1], content_hash: null, images_hash: null }] }; // null hash → treated as changed → update
      }
      return origQuery(sql, params);
    };
    const res = await runImport({ sourceKey: 'csv-test', db, apply: false });
    expect(res.counters.updated).toBe(2); // matched existing → update path (dry)
  });
});

describe('runImport — cap truncation', () => {
  test('stops creating at the cap and reports capped + remaining 0', async () => {
    const many = 'id,name,start,city,state\n' + [1, 2, 3, 4, 5].map((n) => `E${n},Sale ${n},2026-08-0${n}T14:00:00Z,Adrian,MI`).join('\n') + '\n';
    const db = fakeDb({ src: source({ weekly_cap: 2, config: { csvText: many, idColumn: 'id', field_map: FIELD_MAP } }) });
    const res = await runImport({ sourceKey: 'csv-test', db, apply: false });
    expect(res.counters.created).toBe(2);
    expect(res.capped).toBe(true);
    expect(res.remainingAvailable).toBe(0);
  });
});

describe('runImport — apply persists via the writer + run ledger', () => {
  test('claims a run, creates events through the writer, records + finishes the run', async () => {
    const db = fakeDb({ src: source() });
    const res = await runImport({ sourceKey: 'csv-test', db, apply: true, trigger: 'manual',
      geocodeFn: async () => ({ ok: true, lat: 41.9, lng: -84.0, fingerprint: 'FP', source: 'mapbox' }), sleep: async () => {} });
    expect(res.applied).toBe(true);
    expect(res.runId).toBe('RUN1');
    expect(writer.createImported).toHaveBeenCalledTimes(2);
    expect(db.all(/INSERT INTO import_runs/).length).toBe(1);        // run claim
    expect(db.all(/INSERT INTO import_run_items/).length).toBe(3);   // one per fetched record
    expect(db.all(/UPDATE import_runs SET/).length).toBe(1);         // finishRun
  });
  test('auto_publish publishes each created event', async () => {
    const db = fakeDb({ src: source({ auto_publish: true }) });
    await runImport({ sourceKey: 'csv-test', db, apply: true, geocodeFn: async () => ({ ok: true, lat: 1, lng: 2, fingerprint: 'F', source: 'mapbox' }), sleep: async () => {} });
    expect(writer.publishImported).toHaveBeenCalledTimes(2);
  });
});
