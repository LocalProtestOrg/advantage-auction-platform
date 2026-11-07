'use strict';

/**
 * Owner decisions 1 and 2 (2026-09-27): public fee and buyer's premium wording must match what the platform
 * actually does, so neither the website nor Sasha repeats outdated statements.
 *   1. Individual sellers: no platform fee, a 3% payment processing fee on the hammer price (exact, not "about").
 *      No "at launch". Professional auctions: the standard 4% platform fee plus a separate 3%
 *      processing fee may be stated, always with the Professional Seller agreement governing (owner direction 2026-11-06,
 *      replacing the 2026-09-27 "no standard % advertised" rule).
 *   2. Buyer-facing premium wording is neutral about who receives it; the worked example is 18% and labelled
 *      as an example.
 */

const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', 'public');
// Copy only: styles and scripts removed so CSS values cannot trip the checks.
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');

const SELLER_PAGES = ['faq.html', 'how-it-works.html', 'how-sellers-get-paid.html', 'seller-faq.html', 'seller-pilot.html', 'start-selling.html', 'professional-sellers.html'];
const BUYER_PAGES = ['buyer-faq.html', 'how-to-buy.html', 'faq.html'];

describe('Decision 1: seller fee wording', () => {
  test.each(SELLER_PAGES)('%s has no "at launch", no approximate processing fee and no unqualified "no seller platform fee"', (f) => {
    const html = read(f);
    expect(html).not.toMatch(/at launch/i);
    expect(html).not.toMatch(/approximate(ly)? 3%|about 3%|~\s*3%|roughly 3%/i);
    expect(html).not.toMatch(/no seller platform fee/i);
  });
  test.each(SELLER_PAGES)('%s states any standard professional fee as 4% plus a separate 3% processing fee, never combined', (f) => {
    const html = read(f);
    expect(html).not.toMatch(/\b7\s*%\s*(commission|fee|total)/i);
    if (/\b4\s*%\s*(platform|software)/i.test(html)) expect([f, /4% platform fee plus a 3% payment processing fee/i.test(html)]).toEqual([f, true]);
  });
  test('fee pages state the individual fee exactly and point professionals to their agreement', () => {
    for (const f of ['faq.html', 'how-sellers-get-paid.html', 'seller-faq.html', 'start-selling.html', 'how-it-works.html']) {
      const html = read(f);
      expect([f, /3% payment processing/i.test(html)]).toEqual([f, true]);
      expect([f, /Professional Seller agreement/.test(html)]).toEqual([f, true]);
    }
  });
  test('the professional seller-create hint no longer states a fixed 4% fee', () => {
    const html = read('seller-create.html');
    expect(html).not.toMatch(/4% platform\/software fee/);
    expect(html).toMatch(/platform\/software fee is set in your Professional Seller agreement/);
  });
  test('search and share descriptions for how-sellers-get-paid match the page', () => {
    const raw = fs.readFileSync(path.join(PUB, 'how-sellers-get-paid.html'), 'utf8');
    const metas = raw.match(/<meta[^>]+(description|keywords)[^>]*>/gi).join('\n');
    expect(metas).not.toMatch(/at launch|approximate/i);
    expect(metas).toMatch(/Individual sellers pay no platform fee or commission/);
  });
  test('worked payout examples use exactly 3% of the hammer price (rounded)', () => {
    const html = read('how-sellers-get-paid.html');
    for (const [hammer, fee] of [['1,350', '41'], ['2,480', '74'], ['4,920', '148']]) {
      expect(html).toContain('$' + hammer);
      expect(html).toContain('− $' + fee);
    }
  });
});

describe('Decision 2: buyer premium wording', () => {
  test.each(BUYER_PAGES)('%s does not say who receives the premium and has no 15%% example', (f) => {
    const html = read(f);
    expect(html).not.toMatch(/goes to Advantage\.Bid as a platform fee/i);
    expect(html).not.toMatch(/premium is 15%|15% buyer/i);
    expect(html).not.toMatch(/premium[^.]{0,40}marketplace fee|marketplace fee added to your winning bid/i);
  });
  test('the buyer FAQ example is 18%, before tax, and labelled as an example', () => {
    const html = read('buyer-faq.html');
    expect(html).toMatch(/For example, if your winning bid is \$100 and the buyer premium is 18%, your total is \$118 before any applicable sales tax\./);
    expect(html).toMatch(/This is only an example/);
  });
});
