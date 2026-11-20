'use strict';
/* The owner-approved storefront commission wording (2026-11-19) appears, exactly as written, on Start Selling and the
   professional seller onboarding and storefront marketing pages. */
const fs = require('fs');
const path = require('path');
const { HEADLINE, BODY, withoutApproved } = require('./helpers/approvedStorefrontCommissionCopy');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const PAGES = ['start-selling.html', 'become-seller.html', 'become-professional-seller.html', 'professional-sellers.html', 'sell-online.html'];

test('the approved wording is exact', () => {
  expect(HEADLINE).toBe('One Simple Commission. No Hidden Processing Fees.');
  expect(BODY).toBe('Pay just 5% on sales originating from your own embedded storefront or 9% on sales originating from the Advantage.Bid marketplace. Roughly 3% standard Stripe credit card processing is included. No monthly fees or listing fees.');
});
test.each(PAGES)('%s carries the headline and the full statement once, unaltered', (f) => {
  const html = read(f);
  expect(html.split(HEADLINE).length - 1).toBe(1);
  expect(html.split(BODY).length - 1).toBe(1);
});
test('on Start Selling it sits in the Open an Online Storefront section', () => {
  const s = read('start-selling.html');
  const card = s.slice(s.indexOf('id="way-storefront"'), s.indexOf('id="way-auctions"'));
  expect(card).toContain(HEADLINE);
  expect(card).toContain(BODY);
});
test.each(PAGES)('%s: outside the approved statement, no processor name, no approximate rate and no separate processing charge for storefront sales', (f) => {
  const rest = withoutApproved(read(f));
  expect(rest).not.toMatch(/\bStripe\b/);
  expect(rest).not.toMatch(/approximate(ly)? 3%|about 3%|~\s*3%|roughly 3%/i);
  expect(rest).not.toMatch(/(5|9)%\s*(plus|\+)\s*(a\s*)?(3%|processing)/i);
  expect(rest).not.toMatch(/11%|8%\s*\+\s*3%/);
});
