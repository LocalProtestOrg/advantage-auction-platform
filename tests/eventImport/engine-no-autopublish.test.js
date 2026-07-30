'use strict';

// Commit 14 — the noAutoPublish caller override on the engine. The scheduled worker passes it so
// imports stay in DRAFT for the Admin Review Queue even when a source is configured to auto_publish.
// Absent (the default), existing behavior is preserved. Mirrors engine.test.js's harness.

jest.mock('../../src/services/eventImport/writer', () => ({
  createImported: jest.fn(async () => 'EV-new'),
  updateImported: jest.fn(async () => 'EV-upd'),
  publishImported: jest.fn(async () => true),
}));

const { runImport } = require('../../src/services/eventImport/index');
const writer = require('../../src/services/eventImport/writer');

const FIELD_MAP = { title: 'name', start_at: 'start', city: 'city', state: 'state', timezone: { const: 'America/New_York' } };
const CSV = 'id,name,start,city,state\nE1,Adrian Estate Sale,2026-08-01T14:00:00Z,Adrian,MI\nE2,Tecumseh Sale,2026-08-02T14:00:00Z,Tecumseh,MI\n';

function source(over) {
  return Object.assign({ id: 'src-1', key: 'csv-test', kind: 'csv', name: 'CSV Test', owner_organization_id: 'org-1',
    weekly_cap: 75, auto_publish: true, config: { csvText: CSV, idColumn: 'id', field_map: FIELD_MAP } }, over || {});
}
function fakeDb(src) {
  return {
    query: async (sql) => {
      if (/FROM import_sources WHERE key/.test(sql)) return { rows: [src] };
      if (/INSERT INTO import_runs/.test(sql)) return { rows: [{ id: 'RUN1', started_at: 't' }] };
      return { rows: [] };
    },
    withTransaction: async (cb) => cb({ query: async () => ({ rows: [] }) }),
  };
}
const GEO = { geocodeFn: async () => ({ ok: true, lat: 1, lng: 2, fingerprint: 'F', source: 'mapbox' }), sleep: async () => {} };

beforeEach(() => { writer.createImported.mockClear(); writer.publishImported.mockClear(); });

describe('runImport noAutoPublish override', () => {
  test('auto_publish source + noAutoPublish:true → creates DRAFTS, never publishes', async () => {
    const db = fakeDb(source({ auto_publish: true }));
    await runImport({ sourceKey: 'csv-test', db, apply: true, noAutoPublish: true, withTransaction: db.withTransaction, ...GEO });
    expect(writer.createImported).toHaveBeenCalledTimes(2);
    expect(writer.publishImported).not.toHaveBeenCalled();
  });

  test('auto_publish source WITHOUT the override → still publishes (behavior preserved)', async () => {
    const db = fakeDb(source({ auto_publish: true }));
    await runImport({ sourceKey: 'csv-test', db, apply: true, withTransaction: db.withTransaction, ...GEO });
    expect(writer.publishImported).toHaveBeenCalledTimes(2);
  });
});
