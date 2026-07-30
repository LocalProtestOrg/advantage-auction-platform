'use strict';

const d = require('../../src/services/eventImport/dedupe');

const REC = {
  sourceEventId: 'S1', sourceUrl: 'https://host.com/sale-a?utm_source=x', contentHash: 'HASH1', imagesHash: 'IMG1',
  canonical: {
    start_at: '2026-08-01T14:00:00Z', zip: '49221', city: 'Adrian', state: 'MI',
    organizer_name: 'Smith Estates', address: '123 Main St', title: 'Smith Family Estate Sale',
  },
};

describe('signals (pure)', () => {
  test('eventFingerprint is deterministic + normalization-insensitive', () => {
    const a = d.eventFingerprint({ organizer_name: 'Smith  Estates', address: '123 MAIN st.', start_at: '2026-08-01T14:00:00Z' });
    const b = d.eventFingerprint({ organizer_name: 'smith estates', address: '123 main st', start_at: '2026-08-01T23:59:00Z' });
    expect(a).toBe(b); // same normalized organizer/street/date
    expect(a).not.toBe(d.eventFingerprint({ organizer_name: 'Jones', address: '123 Main St', start_at: '2026-08-01T14:00:00Z' }));
  });
  test('titleSimilarity: high for near-duplicates, low for unrelated, stopwords ignored', () => {
    expect(d.titleSimilarity('Smith Family Estate Sale', 'Smith Family Estate Auction')).toBeGreaterThanOrEqual(0.6);
    expect(d.titleSimilarity('Smith Family Estate Sale', 'Downtown Tool Liquidation')).toBeLessThan(0.3);
  });
  test('changeDetect: content_hash equal → unchanged; images hash drives re-sync', () => {
    expect(d.changeDetect(REC, { content_hash: 'HASH1', images_hash: 'IMG1' })).toEqual({ unchanged: true, imagesChanged: false });
    expect(d.changeDetect(REC, { content_hash: 'HASH1', images_hash: 'OLD' })).toEqual({ unchanged: true, imagesChanged: true });
    expect(d.changeDetect(REC, { content_hash: 'DIFF', images_hash: 'IMG1' })).toEqual({ unchanged: false, imagesChanged: false });
  });
});

describe('resolve (pure classification per tier + precedence)', () => {
  test('tier 1 — source_event_id match, changed → update', () => {
    expect(d.resolve(REC, { bySourceEventId: { event_id: 'E1', content_hash: 'DIFF', images_hash: 'IMG1' } }))
      .toMatchObject({ outcome: 'update', eventId: 'E1', matchVia: 'source_event_id', imagesChanged: false });
  });
  test('tier 1 — unchanged content_hash → unchanged (zero writes)', () => {
    expect(d.resolve(REC, { bySourceEventId: { event_id: 'E1', content_hash: 'HASH1', images_hash: 'IMG1' } }))
      .toMatchObject({ outcome: 'unchanged', eventId: 'E1' });
  });
  test('tier 2 — source_url match → update via source_url', () => {
    expect(d.resolve(REC, { bySourceUrl: { event_id: 'E2', content_hash: 'DIFF', images_hash: 'X' } }))
      .toMatchObject({ outcome: 'update', eventId: 'E2', matchVia: 'source_url' });
  });
  test('tier 3 — exactly one fingerprint match → link + update', () => {
    expect(d.resolve(REC, { byFingerprint: ['E3'] })).toMatchObject({ outcome: 'update', eventId: 'E3', matchVia: 'fingerprint' });
  });
  test('tier 3 — multiple fingerprint matches → AMBIGUOUS, never merged', () => {
    expect(d.resolve(REC, { byFingerprint: ['E3', 'E4'] })).toMatchObject({ outcome: 'ambiguous', reason: 'fingerprint_multi' });
  });
  test('tier 4 — soft signal → create + possible_duplicate (never auto-merged)', () => {
    expect(d.resolve(REC, { bySoftSignal: ['E5'] })).toMatchObject({ outcome: 'create', possibleDuplicate: true });
  });
  test('no match → create', () => { expect(d.resolve(REC, {})).toEqual({ outcome: 'create', possibleDuplicate: false }); });
  test('precedence: source_event_id > source_url > fingerprint > soft', () => {
    const all = { bySourceEventId: { event_id: 'A', content_hash: 'x' }, bySourceUrl: { event_id: 'B' }, byFingerprint: ['C'], bySoftSignal: ['D'] };
    expect(d.resolve(REC, all).eventId).toBe('A');
    expect(d.resolve(REC, { bySourceUrl: { event_id: 'B' }, byFingerprint: ['C'], bySoftSignal: ['D'] }).eventId).toBe('B');
    expect(d.resolve(REC, { byFingerprint: ['C'], bySoftSignal: ['D'] }).eventId).toBe('C');
  });
});

describe('dedupe (DB-backed ladder)', () => {
  // fake db routing by query text
  function fakeDb({ tier1 = [], tier2 = [], events = [] } = {}) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/FROM event_sources WHERE source_id=\$1 AND source_event_id=\$2/.test(sql)) return { rows: tier1 };
        if (/FROM event_sources WHERE source_id=\$1 AND source_url_hash=\$2/.test(sql)) return { rows: tier2 };
        if (/FROM events/.test(sql)) return { rows: events };
        return { rows: [] };
      },
    };
  }
  test('tier-1 hit short-circuits (no events query)', async () => {
    const db = fakeDb({ tier1: [{ event_id: 'E1', content_hash: 'HASH1', images_hash: 'IMG1' }] });
    const out = await d.dedupe(db, REC, { sourceId: 'src' });
    expect(out).toMatchObject({ outcome: 'unchanged', eventId: 'E1' });
    expect(db.calls.some((c) => /FROM events/.test(c.sql))).toBe(false);
  });
  test('fingerprint path: one matching candidate → update', async () => {
    const db = fakeDb({ events: [
      { id: 'E9', organizer_name: 'Smith Estates', address: '123 Main St', title: 'Smith Estate Sale', start_at: '2026-08-01T14:00:00Z', zip: '49221' },
      { id: 'E8', organizer_name: 'Different Co', address: '9 Other Rd', title: 'Other', start_at: '2026-08-01T14:00:00Z', zip: '49221' },
    ] });
    const out = await d.dedupe(db, REC, { sourceId: 'src' });
    expect(out).toMatchObject({ outcome: 'update', eventId: 'E9', matchVia: 'fingerprint' });
  });
  test('two fingerprint matches → ambiguous (skipped)', async () => {
    const same = { organizer_name: 'Smith Estates', address: '123 Main St', start_at: '2026-08-01T14:00:00Z', zip: '49221', title: 'x' };
    const db = fakeDb({ events: [{ id: 'A', ...same }, { id: 'B', ...same }] });
    const out = await d.dedupe(db, REC, { sourceId: 'src' });
    expect(out).toMatchObject({ outcome: 'ambiguous' });
  });
  test('soft signal: same zip+date, similar title, no fingerprint match → create possible_duplicate', async () => {
    const db = fakeDb({ events: [
      { id: 'S9', organizer_name: 'Totally Different Org', address: 'zzz', title: 'Smith Family Estate Auction', start_at: '2026-08-01T14:00:00Z', zip: '49221' },
    ] });
    const out = await d.dedupe(db, REC, { sourceId: 'src' });
    expect(out).toMatchObject({ outcome: 'create', possibleDuplicate: true });
  });
  test('no candidates → create', async () => {
    const out = await d.dedupe(fakeDb({}), REC, { sourceId: 'src' });
    expect(out).toEqual({ outcome: 'create', possibleDuplicate: false });
  });
});
