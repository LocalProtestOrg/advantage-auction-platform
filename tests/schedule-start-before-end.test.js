'use strict';

/**
 * PR A — launch-critical schedule validation: an auction's end (close) may never
 * be before its start. Applies to all sellers AND admins (non-overridable), on the
 * authoritative server path (createAuction + updateAuction via assertStartBeforeEnd).
 */

const { assertStartBeforeEnd, ScheduleRuleError } = require('../src/services/sellerTypeRules');

function throwsEndBeforeStart(fn) {
  try { fn(); return null; }
  catch (e) { return e; }
}

describe('assertStartBeforeEnd', () => {
  test('rejects end before start (the reported bug) with a clear SCHEDULE_RULE_VIOLATION', () => {
    const e = throwsEndBeforeStart(() =>
      assertStartBeforeEnd('2026-07-16T19:00:00Z', '2026-07-16T18:10:00Z'));
    expect(e).toBeInstanceOf(ScheduleRuleError);
    expect(e.code).toBe('SCHEDULE_RULE_VIOLATION');
    expect(e.violations[0].rule).toBe('end_before_start');
    expect(e.violations[0].message).toMatch(/end time cannot be before the start time/i);
    // Non-overridable — even an admin cannot proceed past this correctness guard.
    expect(e.adminOverrideAvailable).toBe(false);
  });

  test('allows end after start (valid schedule)', () => {
    expect(throwsEndBeforeStart(() =>
      assertStartBeforeEnd('2026-07-16T18:00:00Z', '2026-07-16T18:10:00Z'))).toBeNull();
  });

  test('allows end equal to start (not "before")', () => {
    expect(throwsEndBeforeStart(() =>
      assertStartBeforeEnd('2026-07-16T18:00:00Z', '2026-07-16T18:00:00Z'))).toBeNull();
  });

  test('no-op when either timestamp is missing (partial drafts / grandfathering)', () => {
    expect(throwsEndBeforeStart(() => assertStartBeforeEnd(null, '2026-07-16T18:10:00Z'))).toBeNull();
    expect(throwsEndBeforeStart(() => assertStartBeforeEnd('2026-07-16T18:00:00Z', null))).toBeNull();
    expect(throwsEndBeforeStart(() => assertStartBeforeEnd(null, null))).toBeNull();
  });

  test('no-op on unparseable input (other layers reject bad input)', () => {
    expect(throwsEndBeforeStart(() => assertStartBeforeEnd('not-a-date', '2026-07-16T18:10:00Z'))).toBeNull();
  });

  test('accepts Date objects as well as ISO strings', () => {
    const e = throwsEndBeforeStart(() =>
      assertStartBeforeEnd(new Date('2026-07-16T19:00:00Z'), new Date('2026-07-16T18:00:00Z')));
    expect(e).toBeInstanceOf(ScheduleRuleError);
  });
});

describe('createAuction / updateAuction wiring (source contract)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'auctionService.js'), 'utf8');

  test('createAuction calls assertStartBeforeEnd on the supplied times', () => {
    expect(src).toMatch(/assertStartBeforeEnd\(startTime, endTime\)/);
  });

  test('updateAuction validates the EFFECTIVE start/end (and start_time triggers the check)', () => {
    expect(src).toMatch(/assertStartBeforeEnd\(effStart, effEnd\)/);
    expect(src).toMatch(/updates\.start_time !== undefined \|\| updates\.end_time !== undefined/);
  });
});
