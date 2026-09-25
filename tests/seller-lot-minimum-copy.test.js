'use strict';

/**
 * Seller auction minimum: every seller-facing surface must match the server rule.
 *
 * Verified policy (src/services/auctionService.js): an online auction needs at least MIN_LOTS_FOR_SUBMISSION
 * valid (non-withdrawn) lots before it can be SUBMITTED (Individual/Private sellers, then Admin review) or
 * PUBLISHED (verified Professional Sellers publish their own; Admin publish). Drafts may be any size. Only
 * an Admin with a written reason may publish below it (audited). The same minimum applies to both seller
 * types; what differs is who publishes.
 *
 * A first seller joined after reading "A 5-lot auction is fine ... no minimum lot count" on start-selling.
 */

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { MIN_LOTS_FOR_SUBMISSION } = require('../src/services/auctionService');

const SURFACES = ['public/start-selling.html', 'public/seller-faq.html', 'public/how-sellers-get-paid.html', 'public/how-it-works.html',
  'public/become-seller.html', 'public/become-professional-seller.html', 'public/seller-create.html', 'public/lot-builder.html',
  'public/admin/sales.html', 'public/demo.html', 'public/professional-sellers.html', 'public/after-estate-sale.html',
  'public/downsizing-liquidation.html'];

describe('seller auction minimum copy', () => {
  test('the server rule is 30 valid lots', () => {
    expect(MIN_LOTS_FOR_SUBMISSION).toBe(30);
  });

  test('no seller surface claims there is no minimum or a small auction size', () => {
    for (const f of SURFACES) {
      const s = read(f);
      expect([f, s.match(/no minimum lot|there's no minimum|there is no minimum|no minimum size|no lot minimum/i)]).toEqual([f, null]);
      expect([f, s.match(/\b(3|5|five|three|12)[- ]lot auction|auction - (5|12) lots|handful of lots/i)]).toEqual([f, null]);
    }
  });

  test('the pages a seller reads before and while building state the 30-lot minimum', () => {
    for (const f of ['public/start-selling.html', 'public/seller-faq.html', 'public/how-it-works.html', 'public/become-seller.html',
      'public/become-professional-seller.html', 'public/seller-create.html', 'public/lot-builder.html', 'public/admin/sales.html']) {
      expect([f, /at least 30 lots|minimum of <b>30 lots<\/b>|at least <b>30 lots<\/b>/i.test(read(f))]).toEqual([f, true]);
    }
  });

  test('seller-type distinctions are preserved: the minimum is shared, the publishing path is not', () => {
    const faq = read('public/seller-faq.html');
    expect(faq).toMatch(/Individual Sellers submit their auction for review and Advantage publishes it/);
    expect(faq).toMatch(/verified Professional Sellers can publish their own qualifying auctions/);
    expect(read('public/become-seller.html')).toMatch(/at least 30 lots before you submit them for review/);
    expect(read('public/become-professional-seller.html')).toMatch(/Once your business is verified, you can publish qualifying auctions yourself/);
  });

  test('structured data on How It Works matches the visible step', () => {
    const s = read('public/how-it-works.html');
    const blocks = s.match(/<script[^>]*ld\+json[^>]*>[\s\S]*?<\/script>/g);
    for (const b of blocks) JSON.parse(b.replace(/<script[^>]*>|<\/script>/g, ''));
    expect(s).toMatch(/"Add each additional lot", "text": "[^"]*at least 30 lots before you submit/);
    expect(s).toMatch(/se-step-callout">Same few steps, lot after lot\. Online auctions need at least 30 lots before you submit/);
  });

  test('payout examples add up (hammer total minus the ~3% processing fee)', () => {
    const s = read('public/how-sellers-get-paid.html');
    const cards = s.split('<div class="example-card">').slice(1);
    expect(cards.length).toBe(3);
    for (const c of cards) {
      const n = (label) => Number((c.match(new RegExp(label + '</span><span class="ex-val"[^>]*>[^$]*\\$([\\d,]+)')) || [])[1].replace(/,/g, ''));
      const lotsTitle = Number((c.match(/ - (\d+) lots</) || [])[1]);
      expect(lotsTitle).toBeGreaterThanOrEqual(30);
      const total = n('Total hammer price'); const fee = n('Payment processing fee \\(~3%\\)'); const payout = n('Your payout');
      expect(Math.abs(fee - total * 0.03)).toBeLessThanOrEqual(1);
      expect(total - fee).toBe(payout);
    }
  });
});
