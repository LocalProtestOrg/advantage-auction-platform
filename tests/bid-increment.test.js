// #3 Bid increment ladder — locks the exact platform schedule and the next-min
// math shared by the server (bidService) and client (bid-utils via bid-increment.js).
const BI = require('../public/widgets/shared/bid-increment');
const bidService = require('../src/services/bidService');

describe('#3 increment ladder — incrementForCents (exact spec boundaries)', () => {
  const cases = [
    [0, 100], [100, 100], [1999, 100],          // $1.00–$19.99 → $1
    [2000, 250], [4999, 250],                    // $20.00–$49.99 → $2.50
    [5000, 500], [19999, 500],                   // $50.00–$199.99 → $5
    [20000, 1000], [49999, 1000],                // $200.00–$499.99 → $10
    [50000, 2500], [99999, 2500],                // $500.00–$999.99 → $25
    [100000, 5000], [249999, 5000],              // $1000.00–$2499.99 → $50
    [250000, 10000], [500000, 10000],            // $2500+ → $100
  ];
  test.each(cases)('price %d¢ → increment %d¢', (price, inc) => {
    expect(BI.incrementForCents(price)).toBe(inc);
  });

  test('the >$1000 defect is fixed (was flat $5)', () => {
    expect(BI.incrementForCents(100000)).toBe(5000); // $1000 → $50, not $5
    expect(BI.incrementForCents(120000)).toBe(5000);
  });
});

describe('#3 nextMinCents', () => {
  test('$1 starting, no bids → opening bid is $1 (fixes catalog/lot $5-vs-$1)', () => {
    expect(BI.nextMinCents(100, 0)).toBe(100);
  });
  test('$5 starting, no bids → opening bid is $5', () => {
    expect(BI.nextMinCents(500, 0)).toBe(500);
  });
  test('$1000 current → next min is $1050 ($50 band)', () => {
    expect(BI.nextMinCents(100, 100000)).toBe(105000);
  });
  test('$25 current → next min is $27.50 ($2.50 band)', () => {
    expect(BI.nextMinCents(100, 2500)).toBe(2750);
  });
  test('flat override wins over ladder', () => {
    expect(BI.nextMinCents(100, 100000, 250)).toBe(100250);
    expect(BI.effectiveIncrement(100000, 250)).toBe(250);
  });
  test('non-positive override falls back to ladder', () => {
    expect(BI.effectiveIncrement(100000, 0)).toBe(5000);
    expect(BI.effectiveIncrement(100000, null)).toBe(5000);
  });
});

describe('#3 server re-exports the SAME ladder (no client/server drift)', () => {
  test('bidService.incrementForCents === ladder', () => {
    for (const price of [0, 1999, 2000, 99999, 100000, 250000]) {
      expect(bidService.incrementForCents(price)).toBe(BI.incrementForCents(price));
    }
  });
  test('bidService.nextMinBidCents matches ladder', () => {
    expect(bidService.nextMinBidCents(100, 100000, null)).toBe(105000);
    expect(bidService.nextMinBidCents(500, 0, null)).toBe(500);
  });
});
