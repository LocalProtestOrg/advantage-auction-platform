'use strict';

// Phase C: pure unit tests for the seller-type schedule validator.
const {
  validateAuctionSchedule,
  isProfessional,
  NON_PRO_MIN_PICKUP_GAP_HOURS,
  MESSAGES,
} = require('../src/services/sellerTypeRules');

const END = '2026-06-01T17:00:00.000Z';                 // auction close
const plusHours = (h) => new Date(new Date(END).getTime() + h * 3.6e6).toISOString();

describe('isProfessional', () => {
  test('professional types classified true', () => {
    ['auction_house', 'estate_sale_company', 'professional_liquidator'].forEach((t) =>
      expect(isProfessional(t)).toBe(true));
  });
  test('non-professional + NULL classified false', () => {
    ['private', 'business', 'other', null, undefined, 'nonsense'].forEach((t) =>
      expect(isProfessional(t)).toBe(false));
  });
});

describe('validateAuctionSchedule — non-professional 48h rule', () => {
  test('exactly 48h after close → ok', () => {
    const r = validateAuctionSchedule({ sellerType: 'private', endTime: END, pickupWindowStart: plusHours(48) });
    expect(r.ok).toBe(true);
  });
  test('47.9h after close → blocked with locked message', () => {
    const r = validateAuctionSchedule({ sellerType: 'private', endTime: END, pickupWindowStart: plusHours(47.9) });
    expect(r.ok).toBe(false);
    expect(r.violations[0].rule).toBe('pickup_min_gap');
    expect(r.violations[0].requiredHours).toBe(48);
    expect(r.violations[0].message).toBe(MESSAGES.pickup_min_gap);
    expect(r.violations[0].message).toMatch(/cannot begin less than 48 hours/);
  });
  test('NULL seller_type treated as non-professional (48h applies)', () => {
    const r = validateAuctionSchedule({ sellerType: null, endTime: END, pickupWindowStart: plusHours(24) });
    expect(r.ok).toBe(false);
    expect(r.violations[0].rule).toBe('pickup_min_gap');
  });
  test('business + other are non-professional', () => {
    ['business', 'other'].forEach((t) => {
      const r = validateAuctionSchedule({ sellerType: t, endTime: END, pickupWindowStart: plusHours(10) });
      expect(r.ok).toBe(false);
    });
  });
});

describe('validateAuctionSchedule — professional exemption', () => {
  test('professional 1h after close → ok (exempt from 48h)', () => {
    ['auction_house', 'estate_sale_company', 'professional_liquidator'].forEach((t) => {
      const r = validateAuctionSchedule({ sellerType: t, endTime: END, pickupWindowStart: plusHours(1) });
      expect(r.ok).toBe(true);
    });
  });
  test('professional still cannot pick up BEFORE close (sanity floor)', () => {
    const r = validateAuctionSchedule({ sellerType: 'auction_house', endTime: END, pickupWindowStart: plusHours(-1) });
    expect(r.ok).toBe(false);
    expect(r.violations[0].rule).toBe('pickup_after_close');
  });
});

describe('validateAuctionSchedule — grandfathering / partial input', () => {
  test('missing pickupWindowStart → no validation (ok)', () => {
    expect(validateAuctionSchedule({ sellerType: 'private', endTime: END, pickupWindowStart: null }).ok).toBe(true);
  });
  test('missing endTime → no validation (ok)', () => {
    expect(validateAuctionSchedule({ sellerType: 'private', endTime: null, pickupWindowStart: plusHours(1) }).ok).toBe(true);
  });
  test('unparseable timestamps → no block', () => {
    expect(validateAuctionSchedule({ sellerType: 'private', endTime: 'nope', pickupWindowStart: 'also-nope' }).ok).toBe(true);
  });
});

describe('constant', () => {
  test('threshold is 48h', () => expect(NON_PRO_MIN_PICKUP_GAP_HOURS).toBe(48));
});

// Override decision at the chokepoint (pure; no DB touched by enforceScheduleRule).
const { enforceScheduleRule } = require('../src/services/auctionService');
const VIOLATING = { sellerType: 'private', endTime: END, pickupWindowStart: plusHours(10) };

describe('enforceScheduleRule — admin override + block decision', () => {
  test('valid schedule → no override, no throw', () => {
    const r = enforceScheduleRule({ sellerType: 'private', endTime: END, pickupWindowStart: plusHours(48), actorRole: 'seller' });
    expect(r.overridden).toBe(false);
  });
  test('seller + violation → throws ScheduleRuleError', () => {
    expect(() => enforceScheduleRule({ ...VIOLATING, actorRole: 'seller' }))
      .toThrow(/seller-type rules/i);
  });
  test('admin + violation + NO reason → throws (must justify)', () => {
    expect(() => enforceScheduleRule({ ...VIOLATING, actorRole: 'admin' })).toThrow();
    try { enforceScheduleRule({ ...VIOLATING, actorRole: 'admin' }); }
    catch (e) { expect(e.code).toBe('SCHEDULE_RULE_VIOLATION'); expect(e.adminOverrideAvailable).toBe(true); }
  });
  test('admin + violation + reason → proceeds (overridden, no throw)', () => {
    const r = enforceScheduleRule({ ...VIOLATING, actorRole: 'admin', overrideReason: 'Pre-arranged early pickup with consignor.' });
    expect(r.overridden).toBe(true);
    expect(r.violations[0].rule).toBe('pickup_min_gap');
  });
  test('seller + violation + reason → still throws (override is admin-only)', () => {
    expect(() => enforceScheduleRule({ ...VIOLATING, actorRole: 'seller', overrideReason: 'please' })).toThrow();
  });
});
