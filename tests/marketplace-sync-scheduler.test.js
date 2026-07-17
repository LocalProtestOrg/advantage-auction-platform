'use strict';

/**
 * Daily BD sync scheduler — pure schedule/enablement logic (no DB, no network).
 * Verifies the run fires once per day at 00:00 America/New_York (DST-aware) and the
 * env-gating policy (enabled in production with BD access; disable flag respected).
 */

const { etDate, etHour, due, enabled } = require('../src/workers/directorySyncWorker');

describe('ET time helpers (DST-aware)', () => {
  test('midnight EST (UTC-5) → hour 0', () => {
    const d = new Date('2026-01-15T05:00:00Z');
    expect(etHour(d)).toBe(0);
    expect(etDate(d)).toBe('2026-01-15');
  });
  test('midnight EDT (UTC-4) → hour 0', () => {
    const d = new Date('2026-07-15T04:00:00Z');
    expect(etHour(d)).toBe(0);
    expect(etDate(d)).toBe('2026-07-15');
  });
  test('2 PM EDT → hour 14', () => {
    expect(etHour(new Date('2026-07-15T18:00:00Z'))).toBe(14);
  });
  test('11 PM ET is still the same ET calendar day (not yet due)', () => {
    const d = new Date('2026-07-16T03:00:00Z'); // 11 PM EDT on the 15th
    expect(etDate(d)).toBe('2026-07-15');
    expect(etHour(d)).toBe(23);
  });
});

describe('due() — once per day at the midnight ET hour', () => {
  const midnight = new Date('2026-07-15T04:00:00Z'); // 00:00 EDT on the 15th
  test('fires when a new ET day begins and it has not run today', () => {
    expect(due(midnight, '2026-07-14')).toBe(true);
    expect(due(midnight, null)).toBe(true);
  });
  test('does not fire twice for the same ET day', () => {
    expect(due(midnight, '2026-07-15')).toBe(false);
  });
  test('does not fire outside the midnight hour', () => {
    expect(due(new Date('2026-07-15T18:00:00Z'), '2026-07-14')).toBe(false); // 2 PM
    expect(due(new Date('2026-07-16T03:00:00Z'), '2026-07-14')).toBe(false); // 11 PM
  });
});

describe('enabled() — production policy', () => {
  test('on in production with BD access', () => {
    expect(enabled({ NODE_ENV: 'production', BD_API_KEY: 'x' })).toBe(true);
  });
  test('explicit opt-in outside production', () => {
    expect(enabled({ BD_API_KEY: 'x', MARKETPLACE_SYNC_ENABLED: 'true' })).toBe(true);
  });
  test('off without BD access even in production', () => {
    expect(enabled({ NODE_ENV: 'production' })).toBe(false);
  });
  test('off by default outside production', () => {
    expect(enabled({ BD_API_KEY: 'x' })).toBe(false);
  });
  test('disable flag wins', () => {
    expect(enabled({ NODE_ENV: 'production', BD_API_KEY: 'x', MARKETPLACE_SYNC_DISABLED: 'true' })).toBe(false);
  });
});
