// #3 Bid increment ladder — locks the exact platform schedule and the next-min
// math shared by the server (bidService) and client (bid-utils via bid-increment.js).
//
// APPROVED BUSINESS RULE (Owner Acceptance): the ladder is WHOLE-DOLLAR only.
// The prior $2.50 band ($20.00–$49.99) was intentionally removed — that range now
// uses the $1 increment. No band may ever generate a half-dollar (".50") bid.
//
// Authoritative ladder (public/widgets/shared/bid-increment.js):
//   $0.01 – $49.99      → $1    (100¢)
//   $50.00 – $199.99    → $5    (500¢)
//   $200.00 – $499.99   → $10   (1000¢)
//   $500.00 – $999.99   → $25   (2500¢)
//   $1000.00 – $2499.99 → $50   (5000¢)
//   $2500.00+           → $100  (10000¢)
const BI = require('../public/widgets/shared/bid-increment');
const bidService = require('../src/services/bidService');

describe('#3 increment ladder — incrementForCents (exact whole-dollar bands)', () => {
  const cases = [
    [0, 100], [100, 100], [1999, 100],           // $0.00–$19.99 → $1
    [2000, 100], [4999, 100],                     // $20.00–$49.99 → $1 (old $2.50 band removed)
    [5000, 500], [19999, 500],                    // $50.00–$199.99 → $5
    [20000, 1000], [49999, 1000],                 // $200.00–$499.99 → $10
    [50000, 2500], [99999, 2500],                 // $500.00–$999.99 → $25
    [100000, 5000], [249999, 5000],               // $1000.00–$2499.99 → $50
    [250000, 10000], [500000, 10000],             // $2500+ → $100
  ];
  test.each(cases)('price %d¢ → increment %d¢', (price, inc) => {
    expect(BI.incrementForCents(price)).toBe(inc);
  });

  test('the >$1000 defect is fixed (was flat $5)', () => {
    expect(BI.incrementForCents(100000)).toBe(5000); // $1000 → $50, not $5
    expect(BI.incrementForCents(120000)).toBe(5000);
  });
});

// Per-band boundary coverage: exact lower bound, exact upper bound, and the first
// cent of the NEXT band (one cent above the upper edge). Each band is [name, loInc,
// hiInc, incCents, nextBandLoCents, nextBandIncCents].
describe('#3 increment ladder — exact band boundaries', () => {
  const bands = [
    { name: '$1 band',   lo: 1,       hi: 4999,   inc: 100,   nextLo: 5000,   nextInc: 500 },
    { name: '$5 band',   lo: 5000,    hi: 19999,  inc: 500,   nextLo: 20000,  nextInc: 1000 },
    { name: '$10 band',  lo: 20000,   hi: 49999,  inc: 1000,  nextLo: 50000,  nextInc: 2500 },
    { name: '$25 band',  lo: 50000,   hi: 99999,  inc: 2500,  nextLo: 100000, nextInc: 5000 },
    { name: '$50 band',  lo: 100000,  hi: 249999, inc: 5000,  nextLo: 250000, nextInc: 10000 },
  ];
  bands.forEach((b) => {
    test(`${b.name}: lower bound ${b.lo}¢ → ${b.inc}¢`, () => {
      expect(BI.incrementForCents(b.lo)).toBe(b.inc);
    });
    test(`${b.name}: upper bound ${b.hi}¢ → ${b.inc}¢`, () => {
      expect(BI.incrementForCents(b.hi)).toBe(b.inc);
    });
    test(`${b.name}: one cent above upper (${b.nextLo}¢) → next band ${b.nextInc}¢`, () => {
      expect(BI.incrementForCents(b.nextLo)).toBe(b.nextInc);
    });
  });
  test('$100 top band: lower bound 250000¢ and well above both → $100', () => {
    expect(BI.incrementForCents(250000)).toBe(10000);
    expect(BI.incrementForCents(999999)).toBe(10000);
  });
  test('negative / zero / garbage inputs clamp to the $1 band', () => {
    expect(BI.incrementForCents(-500)).toBe(100);
    expect(BI.incrementForCents(0)).toBe(100);
    expect(BI.incrementForCents(NaN)).toBe(100);
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
  test('$25 current → next min is $26 (whole-dollar $1 band; not $27.50)', () => {
    // Previously the $20–$50 range used a $2.50 band ($25 → $27.50). Removed.
    expect(BI.nextMinCents(100, 2500)).toBe(2600);
  });
  test('$49.99 current → next min is $50.99 (still $1 band, whole-dollar delta)', () => {
    expect(BI.nextMinCents(100, 4999)).toBe(5099);
  });
  test('$2500 current → next min is $2600 ($100 band)', () => {
    expect(BI.nextMinCents(100, 250000)).toBe(260000);
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

// Owner rule: no ladder-generated bid may contain a half-dollar (".50"). Sweep the
// full range across every band and assert both the increment AND the resulting
// next-min bid land on whole dollars (a multiple of 100¢, never ending in 50¢).
describe('#3 whole-dollar enforcement — no half-dollar bids from the ladder', () => {
  // The increment is whole-dollar for ANY price input (including non-whole-dollar
  // current bids), so sweep a broad range for incrementForCents.
  const anySamples = [1, 100, 1999, 2000, 2500, 4999, 5000, 12345, 19999,
    20000, 33333, 49999, 50000, 75000, 99999, 100000, 175000, 249999,
    250000, 500000, 1000000];
  test.each(anySamples)('increment at %d¢ is a whole dollar (mult of 100, not .50)', (cur) => {
    const inc = BI.incrementForCents(cur);
    expect(inc % 100).toBe(0);
    expect(inc % 100).not.toBe(50);
  });
  // In production every accepted bid is itself a whole-dollar next-min, so the
  // current bid is always a whole dollar. Starting from whole-dollar current bids
  // (one per band), the next minimum must also be whole-dollar because every
  // increment is a multiple of 100¢.
  const wholeDollarCurrents = [100, 2000, 4900, 5000, 19900, 20000, 49900,
    50000, 99900, 100000, 249900, 250000, 500000, 1000000];
  test.each(wholeDollarCurrents)('nextMinCents($1 start, %d¢) is a whole dollar (never ends in .50)', (cur) => {
    const n = BI.nextMinCents(100, cur);
    expect(n % 100).toBe(0);
    expect(n % 100).not.toBe(50);
  });
});

describe('#3 server re-exports the SAME ladder (no client/server drift)', () => {
  test('bidService.incrementForCents === ladder', () => {
    for (const price of [0, 1999, 2000, 4999, 5000, 99999, 100000, 250000]) {
      expect(bidService.incrementForCents(price)).toBe(BI.incrementForCents(price));
    }
  });
  test('bidService.nextMinBidCents matches ladder', () => {
    expect(bidService.nextMinBidCents(100, 100000, null)).toBe(105000);
    expect(bidService.nextMinBidCents(500, 0, null)).toBe(500);
    expect(bidService.nextMinBidCents(100, 2500, null)).toBe(2600); // $25 → $26, whole-dollar
  });
});
