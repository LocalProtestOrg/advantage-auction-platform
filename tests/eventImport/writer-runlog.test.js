'use strict';

jest.mock('../../src/utils/slug', () => ({ generateUniqueSlug: jest.fn(async () => 'estate-sale-abc123') }));
jest.mock('../../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));

const writer = require('../../src/services/eventImport/writer');
const runLog = require('../../src/services/eventImport/runLog');
const { writeAuditLog } = require('../../src/lib/auditLog');

function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return (responder && responder(sql, params)) || { rows: [] };
    },
    find: function (re) { return this.calls.find((c) => re.test(c.sql)); },
    all: function (re) { return this.calls.filter((c) => re.test(c.sql)); },
  };
}

const CTX = {
  canonical: { title: 'Adrian Estate Sale', start_at: '2026-08-01T14:00:00Z', end_at: '2026-08-02T03:59:00Z',
    city: 'Adrian', state: 'MI', zip: '49221', description: 'nice', sale_type: 'estate_sale',
    images: [{ url: 'https://img/1.jpg', position: 0, caption: 'front' }, { url: 'https://img/2.jpg', position: 1 }] },
  geo: { lat: 41.9, lng: -84.0, geocoding_status: 'ok', geocoding_source: 'mapbox', location_fingerprint: 'FP', geocoded_at: '2026-07-30T00:00:00Z' },
  market: { marketSlug: 'national', via: 'fallback' },
  orgId: 'a9a2f8c6-5929-4335-a453-ffef96270e5c',
  provenance: { sourceId: 'src-1', sourceEventId: 'S1', sourceUrl: 'https://host/a', sourceUpdatedAt: '2026-07-29T00:00:00Z', rawPayload: { x: 1 } },
  contentHash: 'CH', imagesHash: 'IH', attribution: { source: 'CSV upload', url: 'https://host/a' },
};

beforeEach(() => { writeAuditLog.mockClear(); });

describe('writer.createImported', () => {
  test('inserts an imported DRAFT event owned by the canonical org, images, provenance, and audits', async () => {
    const db = fakeClient((sql) => (/INSERT INTO events/.test(sql) ? { rows: [{ id: 'EV1' }] } : { rows: [] }));
    const id = await writer.createImported(db, { ...CTX });
    expect(id).toBe('EV1');

    const ins = db.find(/INSERT INTO events/);
    expect(ins.params).toContain('imported');   // source
    expect(ins.params).toContain('draft');       // status
    expect(ins.params).toContain('a9a2f8c6-5929-4335-a453-ffef96270e5c'); // org
    expect(ins.params).toContain('estate-sale-abc123'); // generated slug

    expect(db.all(/INSERT INTO event_images/).length).toBe(2);
    const prov = db.find(/INSERT INTO event_sources/);
    expect(prov.sql).toMatch(/ON CONFLICT \(source_id, source_event_id\)/);
    expect(prov.params).toEqual(expect.arrayContaining(['src-1', 'S1']));

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ event_type: 'event.imported.created', entity_type: 'event', entity_id: 'EV1' });
  });

  test('NEVER reads organization_plans (quota bypass)', async () => {
    const db = fakeClient((sql) => (/INSERT INTO events/.test(sql) ? { rows: [{ id: 'EV1' }] } : { rows: [] }));
    await writer.createImported(db, { ...CTX });
    expect(db.all(/organization_plans/).length).toBe(0);
  });
});

describe('writer.updateImported', () => {
  test('updates mutable fields (never slug/source/status), re-syncs images only when changed', async () => {
    const db = fakeClient(() => ({ rows: [] }));
    await writer.updateImported(db, 'EV1', { ...CTX, imagesChanged: true });
    const upd = db.find(/UPDATE events SET/);
    expect(upd.sql).not.toMatch(/\bslug =|\bsource =|\bstatus =/);
    expect(upd.sql).toMatch(/title = \$/);
    expect(db.find(/DELETE FROM event_images/)).toBeTruthy();
    expect(db.all(/INSERT INTO event_images/).length).toBe(2);

    const db2 = fakeClient(() => ({ rows: [] }));
    await writer.updateImported(db2, 'EV1', { ...CTX, imagesChanged: false });
    expect(db2.find(/DELETE FROM event_images/)).toBeFalsy(); // unchanged → no image churn
  });
});

describe('writer.publishImported', () => {
  // A gate-passing imported draft: host company named + a company-controlled URL + dates/location/image.
  const READY_ROW = {
    source: 'imported', title: 'Nice Estate Sale', start_at: '2999-01-01T15:00:00Z', end_at: '2999-01-02T20:00:00Z',
    event_format: 'live', city: 'Houston', state: 'TX', organizer_name: 'Smith Estate Sales',
    organizer_website_url: 'https://smithestatesales.com', image_count: 4,
  };
  const gateAwareClient = (row) => fakeClient((sql) => {
    if (/FROM events e WHERE e\.id/.test(sql)) return { rows: row ? [row] : [] };       // publication-gate fetch
    if (/UPDATE events SET status = 'published'/.test(sql)) return { rows: [{ id: 'EV1' }] };
    return { rows: [] };
  });

  test('publishes only when the publication gate passes; bypasses quotas', async () => {
    const db = gateAwareClient(READY_ROW);
    const ok = await writer.publishImported(db, 'EV1', CTX);
    expect(ok).toBe(true);
    const q = db.find(/UPDATE events SET status = 'published'/);
    expect(q.sql).toMatch(/source = 'imported' AND status = 'draft'/);
    expect(db.all(/organization_plans/).length).toBe(0);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'event.published' }));
  });
  test('HOLDS (does not publish) when the only destination is the discovery source', async () => {
    const db = gateAwareClient({ ...READY_ROW, organizer_website_url: 'https://www.estatesales.net/x' });
    const ok = await writer.publishImported(db, 'EV1', CTX);
    expect(ok).toBe(false);
    expect(db.all(/UPDATE events SET status = 'published'/).length).toBe(0);  // never published
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'event.publish_held' }));
  });
  test('skipGate=true publishes the raw primitive (trusted caller)', async () => {
    const db = gateAwareClient(null); // no gate fetch needed
    expect(await writer.publishImported(db, 'EV1', { ...CTX, skipGate: true })).toBe(true);
  });
  test('returns false when nothing was in draft', async () => {
    const db = fakeClient(() => ({ rows: [] }));
    expect(await writer.publishImported(db, 'EVX', CTX)).toBe(false);
  });
});

describe('runLog', () => {
  test('scheduled startRun uses the partial-unique run claim; null when lost', async () => {
    const win = fakeClient(() => ({ rows: [{ id: 'RUN1', started_at: 't' }] }));
    const got = await runLog.startRun(win, { sourceId: 'src-1', trigger: 'scheduled', scheduledFor: '2026-08-03' });
    expect(got).toEqual({ id: 'RUN1', started_at: 't' });
    expect(win.find(/INSERT INTO import_runs/).sql).toMatch(/ON CONFLICT \(source_id, scheduled_for\) WHERE trigger = 'scheduled' DO NOTHING/);

    const lost = fakeClient(() => ({ rows: [] })); // conflict → no row
    expect(await runLog.startRun(lost, { sourceId: 'src-1', trigger: 'scheduled', scheduledFor: '2026-08-03' })).toBeNull();
  });
  test('manual startRun always inserts', async () => {
    const db = fakeClient(() => ({ rows: [{ id: 'RUN2' }] }));
    expect((await runLog.startRun(db, { sourceId: 'src-1', trigger: 'manual' })).id).toBe('RUN2');
  });
  test('recordItem + finishRun write the ledger', async () => {
    const db = fakeClient(() => ({ rows: [] }));
    await runLog.recordItem(db, 'RUN1', { sourceEventId: 'S1', eventId: 'EV1', outcome: 'created', matchVia: null, marketVia: 'fallback' });
    expect(db.find(/INSERT INTO import_run_items/).params).toEqual(expect.arrayContaining(['RUN1', 'S1', 'EV1', 'created']));
    await runLog.finishRun(db, 'RUN1', { status: 'completed', counters: { fetched: 3, created: 2, failed: 1 }, capped: false });
    const f = db.find(/UPDATE import_runs SET/);
    expect(f.params).toEqual(expect.arrayContaining(['RUN1', 'completed']));
  });
  test('counterFor maps outcomes to ledger counters', () => {
    expect(runLog.counterFor('created')).toBe('created');
    expect(runLog.counterFor('unchanged')).toBe('skipped_duplicate');
    expect(runLog.counterFor('ambiguous')).toBe('skipped_ambiguous');
    expect(runLog.counterFor('rejected_quality')).toBe('skipped_quality');
    expect(runLog.counterFor('failed')).toBe('failed');
  });
});
