'use strict';

/**
 * Seller permission model — server-side enforcement (Final Seller Permission Certification).
 * Guards the fixes for three verified bypasses so they cannot silently regress:
 *   D1: individual lots must start at $1 — the POST /api/auctions/:id/lots path must gate
 *       starting price to professionals (parity with POST /api/lots).
 *   D2: no catalog edits after submission — that same path must apply the canMutateAuction lock.
 *   D3: bid increment is professional-only — both lot routes must gate bid_increment_cents.
 * Source-level assertions (the repo's pattern for route authorization) + the pure gate logic.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const auctionsRoute = read('src/routes/auctions.js');
const lotsRoute = read('src/routes/lots.js');
const { isProfessional } = require('../src/services/sellerTypeRules');
const { PROFESSIONAL_SELLER_TYPES, NON_PROFESSIONAL_SELLER_TYPES } = require('../src/constants/sellerTypes');

// Isolate the POST /:auctionId/lots handler in auctions.js.
const addLotHandler = (() => {
  const start = auctionsRoute.indexOf("router.post('/:auctionId/lots'");
  const end = auctionsRoute.indexOf('router.', start + 10);
  return auctionsRoute.slice(start, end > start ? end : start + 2000);
})();

describe('seller-class classification (pure)', () => {
  test('professional types are exactly the three pro classes', () => {
    expect(PROFESSIONAL_SELLER_TYPES.sort()).toEqual(['auction_house', 'estate_sale_company', 'professional_liquidator']);
    PROFESSIONAL_SELLER_TYPES.forEach((t) => expect(isProfessional(t)).toBe(true));
  });
  test('individual/non-professional (and untyped) are NOT professional', () => {
    [...NON_PROFESSIONAL_SELLER_TYPES, null, undefined, 'unknown'].forEach((t) => expect(isProfessional(t)).toBe(false));
  });
});

describe('D1/D2: POST /api/auctions/:id/lots is gated (no bypass)', () => {
  test('applies the canMutateAuction submission lock', () => {
    expect(addLotHandler).toMatch(/canMutateAuction\(req\.user\.id, req\.user\.role, auctionId\)/);
    expect(addLotHandler).toMatch(/if \(!gate\.allowed\)/);
    expect(addLotHandler).toMatch(/lockErrorMessage\(gate\.reason\)/);
  });
  test('starting price is professional-only (non-pro → $1 default)', () => {
    expect(addLotHandler).toMatch(/isProfessional\(st\.rows\[0\]\.seller_type\)/);
    expect(addLotHandler).toMatch(/effStartingPrice = undefined/);           // stripped for non-pro
    expect(addLotHandler).toMatch(/startingPrice: effStartingPrice/);        // gated value is what's passed to createLot
  });
  test('auctions.js imports the professional gate', () => {
    expect(auctionsRoute).toMatch(/const \{ isProfessional \}\s*=\s*require\('\.\.\/services\/sellerTypeRules'\)/);
  });
});

describe('D3: bid increment is professional-only on both lot routes', () => {
  test('POST /api/lots gates bid_increment_cents', () => {
    expect(lotsRoute).toMatch(/const effBidIncrement\s*=\s*proAllowed \? \(bid_increment_cents \|\| null\) : null/);
    // the gated value (not the raw body) is inserted
    expect(lotsRoute).toMatch(/effBidIncrement, effStartingBid, effReserveCents/);
  });
  test('PUT /api/lots/:lotId gates bid_increment_cents', () => {
    // both the derivation and its use in the UPDATE params
    expect((lotsRoute.match(/const effBidIncrement\s*=\s*proAllowed/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(lotsRoute).toMatch(/effBidIncrement,\s*\/\/ Phase C\.2: null \(platform default\)/);
  });
});

describe('regression guard: the gated POST /api/lots path still gates starting bid + reserve', () => {
  test('starting bid + reserve remain professional-only', () => {
    expect(lotsRoute).toMatch(/const effStartingBid\s*=\s*proAllowed \? \(starting_bid_cents \|\| null\) : null/);
    expect(lotsRoute).toMatch(/proSettingsAllowedForAuction\(req\.user\.role, auctionId\)/);
  });
});
