'use strict';

/**
 * Auction shipping policy (owner decisions 2026-11-04/05; src/lib/auctionShippingPolicy.js): the constants, the buyer
 * label rule, the seller eligibility rule, the shipment checks and the payout release date (confirmed delivery + 3 US
 * Eastern business days, skipping weekends and US federal holidays).
 */
const p = require('../src/lib/auctionShippingPolicy');

const FLAT = { method: 'flat_rate', flat_rate_cents: 2500, handling_days: 3, excluded_states: [] };
const QUOTE = { method: 'quote_required', flat_rate_cents: null, handling_days: 5, excluded_states: [] };
const ELIG = { shipping_eligible: true, shipping_quote_required: false, shipping_restriction: null };

describe('constants (owner policy)', () => {
  test('$500 per-shipment default, $500 signature threshold, 3 business-day hold, off by default', () => {
    expect(p.DEFAULT_PER_SHIPMENT_LIMIT_CENTS).toBe(50000);
    expect(p.SIGNATURE_THRESHOLD_CENTS).toBe(50000);
    expect(p.PAYOUT_HOLD_BUSINESS_DAYS).toBe(3);
    expect(p.auctionShippingEnabled({})).toBe(false);
    expect(p.auctionShippingEnabled({ AUCTION_SHIPPING_ENABLED: 'false' })).toBe(false);
    expect(p.auctionShippingEnabled({ AUCTION_SHIPPING_ENABLED: '1' })).toBe(false);
    expect(p.auctionShippingEnabled({ AUCTION_SHIPPING_ENABLED: 'true' })).toBe(true);
  });
});

describe('lot label', () => {
  test('not marked eligible = Local Pickup, even with a profile', () => {
    const s = p.lotShippingSummary({ shipping_eligible: false }, FLAT);
    expect(s.label).toBe('local_pickup'); expect(s.label_text).toBe('Local Pickup'); expect(s.ships).toBe(false);
  });
  test('eligible but no shipping settings = Local Pickup (never assumed to ship)', () => {
    expect(p.lotShippingSummary(ELIG, null).label).toBe('local_pickup');
  });
  test('eligible, flat rate, no restriction = Shipping Available with the estimate shown', () => {
    const s = p.lotShippingSummary(ELIG, FLAT);
    expect(s.label).toBe('shipping_available'); expect(s.label_text).toBe('Shipping Available');
    expect(s.flat_rate_cents).toBe(2500); expect(s.quote_required).toBe(false);
    expect(s.terms.join(' ')).toContain('Estimated shipping: $25.00.');
    expect(s.max_item_value_cents).toBe(50000);
  });
  test.each([
    ['quote-required profile', ELIG, QUOTE],
    ['quote required on the lot', { ...ELIG, shipping_quote_required: true }, FLAT],
    ['excluded states', ELIG, { ...FLAT, excluded_states: ['AK', 'HI'] }],
    ['restriction text', { ...ELIG, shipping_restriction: 'Frame ships without glass' }, FLAT],
  ])('%s = Limited Shipping', (_n, lot, prof) => {
    const s = p.lotShippingSummary(lot, prof);
    expect(s.label).toBe('limited_shipping'); expect(s.label_text).toBe('Limited Shipping'); expect(s.ships).toBe(true);
  });
  test('quote required shows "quoted after the auction closes", never a rate', () => {
    const s = p.lotShippingSummary(ELIG, QUOTE);
    expect(s.flat_rate_cents).toBeNull();
    expect(s.terms.join(' ')).toContain('Shipping cost is quoted after the auction closes.');
  });
  test('the seller limit is shown in the terms', () => {
    const s = p.lotShippingSummary(ELIG, FLAT, { maxItemValueCents: 150000 });
    expect(s.terms.join(' ')).toContain('up to $1500.00 in total item value');
  });
  test('buyer copy has no long dashes', () => {
    const all = [p.lotShippingSummary(ELIG, { ...FLAT, excluded_states: ['AK'] }), p.lotShippingSummary(ELIG, QUOTE), p.lotShippingSummary(null, null)]
      .flatMap((s) => s.terms).concat(p.EDUCATION_POINTS, [p.PAYOUT_EXPLANATION], Object.values(p.ELIGIBILITY_MESSAGES)).join(' ');
    expect(all).not.toMatch(/[–—―]/);
    expect(all).not.toMatch(/\bAI\b|artificial intelligence/i);
  });
});

describe('auction label (from lots, never from the auction toggle)', () => {
  const avail = p.lotShippingSummary(ELIG, FLAT);
  const limited = p.lotShippingSummary(ELIG, QUOTE);
  const pickup = p.lotShippingSummary(null, null);
  test('no lots or no lot ships = Local Pickup', () => {
    expect(p.auctionShippingLabel([]).label).toBe('local_pickup');
    expect(p.auctionShippingLabel([pickup, pickup]).label).toBe('local_pickup');
  });
  test('every lot Shipping Available = Shipping Available', () => {
    const a = p.auctionShippingLabel([avail, avail]);
    expect(a.label).toBe('shipping_available'); expect(a.shipping_lot_count).toBe(2); expect(a.lot_count).toBe(2);
  });
  test('some lots pickup only = Limited Shipping, never Shipping Available', () => {
    const a = p.auctionShippingLabel([avail, avail, pickup]);
    expect(a.label).toBe('limited_shipping'); expect(a.label_text).toBe('Limited Shipping'); expect(a.shipping_lot_count).toBe(2);
  });
  test('every lot ships but one is restricted = Limited Shipping', () => {
    expect(p.auctionShippingLabel([avail, limited]).label).toBe('limited_shipping');
  });
});

describe('who may offer shipping', () => {
  test('verified (gate not blocked) Professional Seller is eligible; needs the acknowledgment to turn it on', () => {
    const e = p.sellerShippingEligibility({ sellerType: 'auction_house', verificationBlocked: false });
    expect(e).toMatchObject({ eligible: true, can_enable: false, needs_acknowledgment: true, reason: 'professional_verified' });
    expect(p.sellerShippingEligibility({ sellerType: 'auction_house', verificationBlocked: false, acknowledgedAt: new Date() }).can_enable).toBe(true);
  });
  test('unverified Professional Seller is refused', () => {
    const e = p.sellerShippingEligibility({ sellerType: 'estate_sale_company', verificationBlocked: true, acknowledgedAt: new Date() });
    expect(e).toMatchObject({ eligible: false, can_enable: false, reason: 'verification_required' });
  });
  test.each(['private', 'business', 'other', null])('Individual Seller (%s) is refused without admin approval', (t) => {
    const e = p.sellerShippingEligibility({ sellerType: t, capabilities: {}, acknowledgedAt: new Date() });
    expect(e).toMatchObject({ eligible: false, can_enable: false, reason: 'approval_required' });
  });
  test('Individual Seller with the admin approval is eligible', () => {
    const e = p.sellerShippingEligibility({ sellerType: 'private', capabilities: { shipping_enabled: true }, acknowledgedAt: new Date() });
    expect(e).toMatchObject({ eligible: true, can_enable: true, reason: 'individual_approved' });
  });
  test('an inactive account is never eligible', () => {
    expect(p.sellerShippingEligibility({ sellerType: 'auction_house', isActive: false, acknowledgedAt: new Date() }).eligible).toBe(false);
  });
});

describe('shipment rules (enforced at fulfillment in Phase 3)', () => {
  test('limit, tracking and signature', () => {
    expect(p.perShipmentLimitCents(null)).toBe(50000);
    expect(p.perShipmentLimitCents(120000)).toBe(120000);
    expect(p.signatureRequired(50000)).toBe(false);
    expect(p.signatureRequired(50001)).toBe(true);
    expect(p.shipmentViolations({ itemValueCents: 40000, trackingNumber: '1Z' })).toEqual([]);
    expect(p.shipmentViolations({ itemValueCents: 40000 })).toEqual(['tracking_required']);
    expect(p.shipmentViolations({ itemValueCents: 60000, trackingNumber: '1Z' })).toEqual(['over_per_shipment_limit', 'signature_required']);
    expect(p.shipmentViolations({ itemValueCents: 60000, limitCents: 100000, trackingNumber: '1Z', signatureConfirmation: true })).toEqual([]);
    expect(p.shipmentViolations({ itemValueCents: 60000, limitCents: 100000, trackingNumber: '1Z', adminSignatureOverride: true })).toEqual([]);
    expect(p.shipmentViolations({ itemValueCents: 60000, trackingNumber: '1Z', signatureConfirmation: true, adminLimitOverride: true })).toEqual([]);
  });
});

describe('payout release: delivery + 3 US Eastern business days (end of the third)', () => {
  test.each([
    ['Monday delivery → Friday 00:00 ET', '2026-11-02T15:00:00Z', '2026-11-06T05:00:00.000Z'],
    ['Saturday delivery → counts Mon, Tue, Wed → Thursday 00:00 ET', '2026-10-31T15:00:00Z', '2026-11-05T05:00:00.000Z'],
    ['late Sunday night Eastern (Monday in UTC) counts from Sunday', '2026-11-02T04:30:00Z', '2026-11-05T05:00:00.000Z'],
    ['Friday delivery skips the weekend and Veterans Day (Nov 11)', '2026-11-06T15:00:00Z', '2026-11-13T05:00:00.000Z'],
    ['Thanksgiving week skips Thursday', '2026-11-24T15:00:00Z', '2026-12-01T05:00:00.000Z'],
    ['across the March daylight-saving change (EDT midnight = 04:00 UTC)', '2026-03-06T15:00:00Z', '2026-03-12T04:00:00.000Z'],
  ])('%s', (_n, delivered, release) => {
    expect(p.payoutReleaseAt(delivered).toISOString()).toBe(release);
  });
  test('always at least 3 full business days', () => {
    for (let h = 0; h < 24 * 14; h += 5) {
      const d = new Date(Date.UTC(2026, 10, 1, h));
      const r = p.payoutReleaseAt(d);
      expect(r.getTime() - d.getTime()).toBeGreaterThanOrEqual(3 * 86400000);
    }
  });
  test('observed federal holidays (Saturday → Friday, Sunday → Monday)', () => {
    const h2026 = p.usFederalHolidays(2026);
    expect(h2026.has('2026-07-03')).toBe(true);    // July 4 2026 is a Saturday
    expect(h2026.has('2026-11-26')).toBe(true);    // Thanksgiving
    const h2027 = p.usFederalHolidays(2027);
    expect(h2027.has('2027-06-18')).toBe(true);    // Juneteenth on a Saturday
    expect(h2027.has('2027-12-24')).toBe(true);    // Christmas on a Saturday
    expect(h2027.has('2027-12-31')).toBe(true);    // New Year's Day 2028 on a Saturday
    expect(p.isBusinessDay(2026, 11, 11)).toBe(false);
    expect(p.isBusinessDay(2026, 11, 10)).toBe(true);
  });
  test('rejects an invalid date', () => { expect(() => p.payoutReleaseAt('not a date')).toThrow(); });
});
