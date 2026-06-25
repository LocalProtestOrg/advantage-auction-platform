'use strict';

/**
 * Launch-stabilization fixes (staging-approved): H1, H2, M2, L1.
 * Pure / mocked-db unit tests — no network, no live server.
 */

// ── H2: lot validation (size_category / pickup tier required) ────────────────
const { TIERS, normalizeTier, validateLotPayload } = require('../src/validation/lotValidation');

describe('H2 — lotValidation', () => {
  test('normalizeTier accepts A/B/C from either field, case/space tolerant', () => {
    expect(normalizeTier('A')).toBe('A');
    expect(normalizeTier(' b ')).toBe('B');
    expect(normalizeTier('c')).toBe('C');
    expect(normalizeTier(null, 'C')).toBe('C');        // size null, pickup C
    expect(normalizeTier('B', 'C')).toBe('B');          // first valid wins
  });

  test('normalizeTier rejects invalid / dirty values', () => {
    expect(normalizeTier(null)).toBeNull();
    expect(normalizeTier('')).toBeNull();
    expect(normalizeTier('large')).toBeNull();
    expect(normalizeTier('M')).toBeNull();
    expect(normalizeTier('D')).toBeNull();
    expect(normalizeTier(undefined, undefined)).toBeNull();
  });

  test('valid: title + A/B/C tier passes', () => {
    expect(validateLotPayload({ title: 'Walnut Credenza', sizeCategory: 'B' })).toEqual({ valid: true, errors: [] });
  });

  test('missing size_category fails with a clear error', () => {
    const r = validateLotPayload({ title: 'X', sizeCategory: null });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/pickup tier|item size/i);
  });

  test('invalid size_category (dirty value) fails', () => {
    const r = validateLotPayload({ title: 'X', sizeCategory: 'large' });
    expect(r.valid).toBe(false);
  });

  test('missing title fails', () => {
    const r = validateLotPayload({ title: '   ', sizeCategory: 'A' });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/title/i);
  });

  test('TIERS is exactly A/B/C', () => { expect(TIERS).toEqual(['A', 'B', 'C']); });
});

// ── M2 & L1: launch guards ───────────────────────────────────────────────────
const { isInvoicePaid, sellerSettlementsEnabled } = require('../src/lib/launchGuards');

describe('M2 — isInvoicePaid (block "payment required" email on paid invoice)', () => {
  test('paid when invoice row is paid', () => {
    expect(isInvoicePaid({ invoiceStatus: 'paid', paymentStatus: null })).toBe(true);
  });
  test('paid when linked payment is paid', () => {
    expect(isInvoicePaid({ invoiceStatus: 'issued', paymentStatus: 'paid' })).toBe(true);
  });
  test('not paid when both unpaid', () => {
    expect(isInvoicePaid({ invoiceStatus: 'issued', paymentStatus: null })).toBe(false);
    expect(isInvoicePaid({ invoiceStatus: 'issued', paymentStatus: 'pending' })).toBe(false);
  });
  test('safe on empty input', () => { expect(isInvoicePaid()).toBe(false); });
});

describe('L1 — sellerSettlementsEnabled (final report gated OFF by default)', () => {
  test('disabled when env unset', () => { expect(sellerSettlementsEnabled({})).toBe(false); });
  test('disabled for any value other than the exact string "true"', () => {
    expect(sellerSettlementsEnabled({ SELLER_SETTLEMENTS_ENABLED: 'false' })).toBe(false);
    expect(sellerSettlementsEnabled({ SELLER_SETTLEMENTS_ENABLED: '1' })).toBe(false);
    expect(sellerSettlementsEnabled({ SELLER_SETTLEMENTS_ENABLED: 'TRUE' })).toBe(false);
  });
  test('enabled only when exactly "true"', () => {
    expect(sellerSettlementsEnabled({ SELLER_SETTLEMENTS_ENABLED: 'true' })).toBe(true);
  });
});

// ── H1: pickup packet header timezone matches tier rows ──────────────────────
jest.mock('../src/db');

describe('H1 — packet header + tier rows render in the auction timezone', () => {
  let db, getPacketData;
  beforeEach(() => {
    jest.resetModules();
    db = require('../src/db');
    db.query = jest.fn();
    ({ getPacketData } = require('../src/services/pickupPacketService'));
  });

  // Window 13:00–19:00 UTC. In America/Chicago (CDT, UTC-5) in July that is 8 AM–2 PM;
  // a UTC render would show 1 PM start, a server-local render could differ. We assert
  // the header start clock equals the tier-A start clock (consistency) and equals the
  // Central interpretation (tz actually applied, not UTC).
  function mockAuction(tz) {
    db.query
      .mockResolvedValueOnce({ rows: [{
        id: 'a1', title: 'TZ Test', timezone: tz,
        street_address: null, city: 'Chicago', address_state: 'IL', zip: '60601',
        pickup_window_start: '2026-07-18T13:00:00.000Z',
        pickup_window_end: '2026-07-18T19:00:00.000Z',
      }] })
      .mockResolvedValueOnce({ rows: [] }); // no invoices needed for header assertion
  }
  const startClock = (s) => (s ? (s.match(/(\d{1,2}:\d{2}\s*[AP]M)/) || [])[1] : null);

  test('America/Chicago: header and tier A both start 8:00 AM (CDT), not 1:00 PM (UTC)', async () => {
    mockAuction('America/Chicago');
    const packet = await getPacketData('a1');
    expect(packet.auction.tierWindows).not.toBeNull();
    const headerStart = startClock(packet.auction.pickup);
    const tierAStart = startClock(packet.auction.tierWindows.A);
    expect(headerStart).toBe('8:00 AM');           // tz applied (Central)
    expect(tierAStart).toBe('8:00 AM');             // tier row uses same tz
    expect(headerStart).toBe(tierAStart);           // header matches rows (H1)
    expect(packet.auction.pickup).not.toMatch(/1:00 PM/); // not UTC
  });

  test('null timezone falls back to America/New_York consistently (header + rows = 9:00 AM EDT)', async () => {
    mockAuction(null);
    const packet = await getPacketData('a1');
    expect(startClock(packet.auction.pickup)).toBe('9:00 AM');       // EDT (UTC-4) fallback
    expect(startClock(packet.auction.tierWindows.A)).toBe('9:00 AM');
  });
});
