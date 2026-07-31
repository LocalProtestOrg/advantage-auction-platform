'use strict';

const { createTokenBucket, withBackoff } = require('../../src/services/eventImport/rateLimit');
const geo = require('../../src/services/eventImport/geocode');

describe('createTokenBucket', () => {
  test('allows burst immediately, then throttles to the rate', async () => {
    let t = 0; const now = () => t; const slept = [];
    const sleep = async (ms) => { slept.push(ms); t += ms; };
    const b = createTokenBucket({ ratePerMin: 60, burst: 2, now, sleep }); // 1 token/sec, burst 2
    await b.take(); await b.take();          // consume the burst — no waiting
    expect(slept).toEqual([]);
    await b.take();                          // empty → must wait ~1000ms for one token
    expect(slept).toEqual([1000]);
  });
  test('refills over elapsed time', async () => {
    let t = 0; const now = () => t; const sleep = async (ms) => { t += ms; };
    const b = createTokenBucket({ ratePerMin: 120, burst: 1, now, sleep }); // 2 tokens/sec
    await b.take();               // tokens 0
    t += 500;                     // 500ms → +1 token
    await b.take();               // should be immediate (a token refilled)
    expect(b._state().tokens).toBeCloseTo(0, 5);
  });
});

describe('withBackoff', () => {
  const sleep = async () => {}; const rand = () => 0.5;   // jitter multiplier = 1.0
  test('returns a non-retryable result immediately', async () => {
    let n = 0;
    const r = await withBackoff(async () => { n++; return { ok: true }; }, { isRetryable: () => false, sleep, rand });
    expect(r).toEqual({ ok: true }); expect(n).toBe(1);
  });
  test('retries a retryable result then succeeds; backoff is exponential', async () => {
    const slept = []; let n = 0;
    const r = await withBackoff(async () => { n++; return n < 3 ? { status: 'rate_limited' } : { ok: true }; },
      { retries: 5, baseMs: 100, sleep: async (ms) => slept.push(ms), rand, isRetryable: (x) => x.status === 'rate_limited' });
    expect(r).toEqual({ ok: true }); expect(n).toBe(3);
    expect(slept).toEqual([100, 200]);       // 100*2^0, 100*2^1 (jitter x1.0)
  });
  test('returns the last result after exhausting retries', async () => {
    let n = 0;
    const r = await withBackoff(async () => { n++; return { status: 'rate_limited' }; },
      { retries: 2, baseMs: 1, sleep, rand, isRetryable: () => true });
    expect(r).toEqual({ status: 'rate_limited' }); expect(n).toBe(3); // initial + 2 retries
  });
  test('rethrows a thrown error after exhausting retries', async () => {
    await expect(withBackoff(async () => { throw new Error('boom'); }, { retries: 1, baseMs: 1, sleep, rand }))
      .rejects.toThrow('boom');
  });
});

describe('geocode — shouldGeocodeEvent (reuses the seam, fingerprint-gated)', () => {
  const canonical = { address: '123 Main St', city: 'Adrian', state: 'MI', zip: '49221' };
  const fp = geo.eventLocationFingerprint(canonical);
  // Two-tier (migration 102): the coordinate-presence tier is internal_lat/lng (the precise point),
  // not the public lat/lng (which is the offset marker).
  test('skips when location unchanged AND coordinates on file', () => {
    expect(geo.shouldGeocodeEvent(canonical, { internal_lat: 41.9, internal_lng: -84.0, location_fingerprint: fp }).geocode).toBe(false);
  });
  test('geocodes when coordinates missing', () => {
    expect(geo.shouldGeocodeEvent(canonical, {}).geocode).toBe(true);
  });
  test('geocodes when the location fingerprint changed', () => {
    expect(geo.shouldGeocodeEvent(canonical, { internal_lat: 1, internal_lng: 1, location_fingerprint: 'OLD' }).geocode).toBe(true);
  });
  test('does not request when there is no usable location at all', () => {
    expect(geo.shouldGeocodeEvent({ address: null, city: null, state: null, zip: null }, {}).geocode).toBe(false);
  });
});

describe('geocode — geocodeEvent (throttle + backoff + fingerprint + fail-open)', () => {
  const canonical = { address: '123 Main St', city: 'Adrian', state: 'MI', zip: '49221' };
  test('success persists coordinates + fingerprint + status', async () => {
    const gf = async () => ({ ok: true, lat: 41.9, lng: -84.0, fingerprint: 'FP', source: 'mapbox', normalized: 'Adrian, MI' });
    const out = await geo.geocodeEvent(canonical, {}, { geocodeFn: gf, now: () => '2026-08-01T00:00:00.000Z' });
    expect(out).toMatchObject({ geocoded: true, lat: 41.9, lng: -84.0, location_fingerprint: 'FP', geocoding_status: 'ok', geocoding_source: 'mapbox', geocoded_at: '2026-08-01T00:00:00.000Z' });
  });
  test('unchanged location → skipped, existing coords carried, no provider call', async () => {
    const fp = geo.eventLocationFingerprint(canonical);
    let called = false; const gf = async () => { called = true; return { ok: true }; };
    const out = await geo.geocodeEvent(canonical, { internal_lat: 1, internal_lng: 2, location_fingerprint: fp }, { geocodeFn: gf });
    expect(out).toMatchObject({ geocoded: false, reason: 'unchanged', lat: 1, lng: 2 });
    expect(called).toBe(false);
  });
  test('provider failure PRESERVES existing coordinates', async () => {
    const gf = async () => ({ ok: false, status: 'no_result', error: 'none' });
    const out = await geo.geocodeEvent(canonical, { internal_lat: 10, internal_lng: 20, location_fingerprint: 'OLD' }, { geocodeFn: gf });
    expect(out).toMatchObject({ geocoded: false, geocoding_status: 'no_result', lat: 10, lng: 20 });
  });
  test('retries transient failures, throttling before each attempt', async () => {
    let calls = 0; const taken = [];
    const bucket = { take: async () => { taken.push(1); } };
    const gf = async () => { calls++; return calls < 2 ? { status: 'rate_limited' } : { ok: true, lat: 1, lng: 2, fingerprint: 'F', source: 'mapbox' }; };
    const out = await geo.geocodeEvent(canonical, {}, { geocodeFn: gf, bucket, sleep: async () => {}, rand: () => 0.5 });
    expect(out.geocoded).toBe(true);
    expect(calls).toBe(2);
    expect(taken.length).toBe(2); // take() before each attempt
  });
  test('a thrown provider → fail-open, coordinates preserved, status failed', async () => {
    const gf = async () => { throw new Error('boom'); };
    const out = await geo.geocodeEvent(canonical, { internal_lat: 5, internal_lng: 6 }, { geocodeFn: gf, retries: 0, sleep: async () => {}, rand: () => 0.5 });
    expect(out).toMatchObject({ geocoded: false, geocoding_status: 'failed', lat: 5, lng: 6 });
  });
});
