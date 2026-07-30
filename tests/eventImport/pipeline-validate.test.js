'use strict';

const { validate } = require('../../src/services/eventImport/validate');
const { applyFieldMap } = require('../../src/services/eventImport/normalize/fieldMap');
const { normalizeItem, runStages, normalizeStage } = require('../../src/services/eventImport/pipeline');

const ok = { title: 'Estate Sale', start_at: '2026-08-01T14:00:00Z', end_at: '2026-08-02T03:59:00.000Z', city: 'Adrian', state: 'MI' };

describe('validate — quality gates', () => {
  test('passes a complete record', () => { expect(validate(ok)).toEqual({ ok: true, outcome: 'ok' }); });
  test('missing title/start/location', () => {
    expect(validate({ ...ok, title: '' }).reason).toBe('missing:title');
    expect(validate({ ...ok, start_at: null }).reason).toBe('missing:start_at');
    expect(validate({ ...ok, city: null, state: null, zip: null, lat: null, lng: null }).reason).toBe('missing:location');
  });
  test('location satisfied by zip OR lat/lng', () => {
    expect(validate({ ...ok, city: null, state: null, zip: '49221' }).ok).toBe(true);
    expect(validate({ ...ok, city: null, state: null, lat: 41.9, lng: -84.0 }).ok).toBe(true);
  });
  test('end before start', () => { expect(validate({ ...ok, end_at: '2026-07-01T00:00:00Z' }).reason).toBe('end_before_start'); });
  test('no computable end_at → rejected (never published)', () => {
    expect(validate({ ...ok, end_at: null })).toEqual({ ok: false, outcome: 'rejected_quality', reason: 'no_computable_end_at' });
  });
  test('already-ended is rejected as stale when now is supplied', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    expect(validate(ok, { now }).reason).toBe('already_ended');
    expect(validate(ok, { now: Date.parse('2026-07-01T00:00:00Z') }).ok).toBe(true);
  });
});

describe('applyFieldMap — declarative mapping', () => {
  const payload = { evt: { name: 'Big Sale', starts: '2026-08-01T14:00:00Z' }, loc: { town: 'Adrian', region: 'MI' } };
  const map = {
    title: 'evt.name',
    start_at: { path: 'evt.starts' },
    city: 'loc.town',
    state: { path: 'loc.region', transform: (v) => String(v).toUpperCase() },
    sale_type: { const: 'estate_sale' },
    timezone: { path: 'nope', default: 'America/New_York' },
  };
  test('extracts dot-paths, applies transform/const/default, omits missing', () => {
    expect(applyFieldMap(payload, map)).toEqual({
      title: 'Big Sale', start_at: '2026-08-01T14:00:00Z', city: 'Adrian', state: 'MI',
      sale_type: 'estate_sale', timezone: 'America/New_York',
    });
  });
  test('a throwing transform omits that field, does not crash', () => {
    expect(applyFieldMap(payload, { title: { path: 'evt.name', transform: () => { throw new Error('x'); } } })).toEqual({});
  });
});

describe('normalizeItem — fieldMap → sanitize → validate', () => {
  const FIELD_MAP = { title: 'name', start_at: 'starts', city: 'city', state: 'state', timezone: { const: 'America/New_York' } };
  test('eligible record carries canonical + hashes', () => {
    const r = normalizeItem({ sourceEventId: 'A1', sourceUrl: 'https://h/a', payload: { name: 'Sale', starts: '2026-08-01T14:00:00Z', city: 'Adrian', state: 'MI' } }, { fieldMap: FIELD_MAP });
    expect(r.outcome).toBe('eligible');
    expect(r.canonical.end_at).toBe('2026-08-02T03:59:00.000Z');
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.sourceEventId).toBe('A1');
    expect(r.terminal).toBe(false);
  });
  test('quality-rejected record is terminal', () => {
    const r = normalizeItem({ sourceEventId: 'A2', payload: { starts: '2026-08-01T14:00:00Z', city: 'X', state: 'MI' } }, { fieldMap: FIELD_MAP });
    expect(r.outcome).toBe('rejected_quality');
    expect(r.reason).toBe('missing:title');
    expect(r.terminal).toBe(true);
  });
});

describe('runStages — per-record isolation, one bad record never aborts the run', () => {
  const FIELD_MAP = { title: 'name', start_at: 'starts', city: 'city', state: 'state', timezone: { const: 'America/New_York' } };
  const raws = [
    { sourceEventId: '1', payload: { name: 'Good', starts: '2026-08-01T14:00:00Z', city: 'Adrian', state: 'MI' } },
    { sourceEventId: '2', payload: { name: 'NoLoc', starts: '2026-08-01T14:00:00Z' } },           // rejected_quality
    { sourceEventId: '3', payload: { name: 'Boom', starts: '2026-08-01T14:00:00Z', city: 'A', state: 'MI' } },
  ];
  test('normalize + a throwing downstream stage isolates to its record', async () => {
    const explode = async (rec) => { if (rec.sourceEventId === '3') throw new Error('kaboom'); return rec; };
    const { items, summary } = await runStages(raws, [normalizeStage({ fieldMap: FIELD_MAP }), explode], {});
    expect(summary.total).toBe(3);
    expect(items.find((i) => i.sourceEventId === '1').outcome).toBe('eligible');
    expect(items.find((i) => i.sourceEventId === '2').outcome).toBe('rejected_quality'); // terminal → explode not reached
    const bad = items.find((i) => i.sourceEventId === '3');
    expect(bad.outcome).toBe('failed');
    expect(bad.error).toMatch(/kaboom/);
    expect(summary.byOutcome).toEqual({ eligible: 1, rejected_quality: 1, failed: 1 });
  });
});
