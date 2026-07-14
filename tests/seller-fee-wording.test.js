'use strict';

/**
 * Seller fee-wording guard (launch-stabilization). Proves seller-facing copy does
 * not claim an Advantage platform fee / 10% seller fee, and uses the approved
 * "payment processing fee" language. Also re-asserts the final seller report stays
 * blocked while Seller Settlements are OFF.
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const SELLER_PAGES = [
  'how-sellers-get-paid.html',
  'start-selling.html',
  'seller-pilot.html',
  'seller-faq.html',
  'how-it-works.html',
];
// The guard checks seller-facing COPY. Strip <style>/<script> so CSS values (e.g. gradient
// coordinates like "20% 10%") and inline JS can never false-positive the fee-wording checks.
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ');

// Substrings that assert a seller platform fee / 10% seller-fee claim. None may appear.
const FORBIDDEN = [
  /platform fee \(10\s*%/i,
  /charges? a platform fee/i,
  /platform fee is a/i,
  /the platform fee only applies/i,
  /minus (the|one) platform fee/i,
  /\bseller fee\b/i,           // "your seller fee" framing
  /10\s*%\s*(platform|seller|commission)/i,
];

describe('seller fee wording — no Advantage platform fee / 10% seller-fee claims', () => {
  SELLER_PAGES.forEach((page) => {
    const html = read(page);
    test(`${page}: contains no "10%" anywhere`, () => {
      expect(html).not.toMatch(/10\s*%/);
    });
    test(`${page}: contains no platform-fee/seller-fee claim`, () => {
      FORBIDDEN.forEach((re) => {
        expect(html).not.toMatch(re);
      });
    });
  });

  test('fee-describing seller pages use "payment processing" language', () => {
    ['how-sellers-get-paid.html', 'start-selling.html', 'seller-pilot.html', 'seller-faq.html', 'how-it-works.html']
      .forEach((page) => {
        expect(read(page).toLowerCase()).toContain('payment processing');
      });
  });

  test('no seller-facing page names Stripe in copy', () => {
    SELLER_PAGES.forEach((page) => {
      // allow none — Stripe naming was removed from seller-facing copy
      expect(read(page)).not.toMatch(/\bStripe\b/);
    });
  });
});

describe('final seller report stays blocked while Seller Settlements are OFF', () => {
  const { sellerSettlementsEnabled } = require('../src/lib/launchGuards');
  test('disabled by default (env unset)', () => {
    expect(sellerSettlementsEnabled({})).toBe(false);
  });
  test('still disabled for non-"true" values', () => {
    expect(sellerSettlementsEnabled({ SELLER_SETTLEMENTS_ENABLED: 'false' })).toBe(false);
  });
});
