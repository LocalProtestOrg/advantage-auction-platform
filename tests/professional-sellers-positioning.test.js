'use strict';

/**
 * professional-sellers.html: the Owner-approved benefits-first positioning (2026-09-27).
 *   - Leads with the seller's business: their auctions on their own website (white-label widget) and the same
 *     auctions on the Advantage.Bid marketplace (dual distribution by design: one auction, two audiences).
 *   - Accurate about today: bidding and checkout happen on Advantage.Bid pages; storefront Buy Now checkout is not
 *     promised; the 30-lot minimum is stated; no buyer-data ownership/export, sell-through or revenue promises, and no
 *     website-only auctions.
 */

const fs = require('fs');
const path = require('path');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'professional-sellers.html'), 'utf8');
const text = page.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const meta = (sel) => (page.match(new RegExp('<meta ' + sel + ' content="([^"]*)"')) || [])[1] || '';

describe('professional-sellers.html: benefits-first', () => {
  test('the hero leads with the seller\'s own website and the second audience', () => {
    expect(page).toMatch(/<h1>Your auctions, on <em>your website<\/em> and in front of more buyers\.<\/h1>/);
    expect(text).toMatch(/Every auction you publish appears on your website through our white-label widget, and on the Advantage\.Bid marketplace for more bidders/);
  });

  test('the page order puts the seller\'s benefits first: two audiences, then growth, then tools, then economics', () => {
    const order = ['id="two-audiences"', 'id="grow"', 'id="tools"', 'Transparent Economics', 'Getting Started'].map((s) => page.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual(order.slice().sort((a, b) => a - b));
  });

  test('all six approved selling points are present', () => {
    for (const h of ['Host auctions on your own website', 'More bidders for the same auction', 'Win more estate contracts',
      'Auction a whole estate, or what is left', 'Offer more services', 'Your buyer\'s premium is yours', 'No auction software to build',
      'Your company, front and center']) {
      expect(text).toContain(h);
    }
  });

  test('dual distribution is described as automatic and as a benefit; no website-only option', () => {
    expect(text).toMatch(/Every auction you publish is shown in both places automatically/);
    expect(text).not.toMatch(/website-only|only on your website|opt out|instead of the marketplace|off the marketplace/i);
  });

  test('accurate about where bidding happens, the lot minimum and storefront checkout', () => {
    expect(text).toMatch(/bidding, payment and checkout take place on Advantage\.Bid's secure auction pages/);
    expect(text).toMatch(/Online auctions need at least 30 lots/);
    expect(text).not.toMatch(/Buy Now checkout/);          // storefront checkout is flag-gated (off in production)
    expect(text).toMatch(/buyers contact you to purchase/);
  });

  test('no outcome, data-ownership or reach promises', () => {
    expect(text).not.toMatch(/\d+\s*% of (the )?(estate|household|contents|items)|sell-through|guarantee|nationwide/i);
    expect(text).not.toMatch(/(own|export|download) (your |the )?(buyer|customer|bidder) (data|list|contacts)/i);
    expect(text).not.toMatch(/\b(increase|double|boost) (your )?(revenue|income|profit)s? by/i);
  });

  test('metadata reflects the new positioning; canonical and social tags preserved', () => {
    expect(page).toMatch(/<link rel="canonical" href="https:\/\/bid\.advantage\.bid\/professional-sellers\.html" \/>/);
    expect(meta('name="description"')).toMatch(/on your own website through a white-label widget and on the Advantage\.Bid marketplace/);
    expect(meta('property="og:title"')).toBe('Your auctions, on your website and in front of more buyers');
    expect(meta('property="og:description"')).toMatch(/One auction, two audiences/);
    expect(meta('property="og:url"')).toBe('https://bid.advantage.bid/professional-sellers.html');
    expect(meta('property="og:image"')).toBe('https://bid.advantage.bid/img/social-card.png');
    expect(meta('name="twitter:card"')).toBe('summary_large_image');
    expect(meta('name="twitter:title"')).toBeTruthy();
    expect(page).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1\.0" \/>/);
  });

  test('signup links, the website example and shared page furniture are preserved', () => {
    expect((page.match(/href="\/become-professional-seller\.html" class="btn-primary"/g) || []).length).toBe(2);
    expect(page).toMatch(/href="\/demo\/example-company-website\.html"/);
    expect(page).toMatch(/href="\/pro\/heritage-home-estate-services"/);
    expect(page).toMatch(/auction-view\.html\?auctionId=00000000-0000-4000-a000-0000000d0003/);
    expect(page).toMatch(/data-adv-public-nav data-variant="professional"/);
    for (const s of ['/widgets/shared/public-nav.js', '/widgets/shared/company-contact.js', '/widgets/shared/behavior-tracker.js', '/widgets/shared/analytics.js']) expect(page).toContain(s);
    expect(page).toMatch(/data-adv-tel/);
  });

  test('accessibility basics: one h1, decorative icons hidden, the in-page link targets exist', () => {
    expect((page.match(/<h1[\s>]/g) || []).length).toBe(1);
    const icons = page.match(/<div class="(ic|aud-plus)"[^>]*>/g) || [];
    expect(icons.length).toBeGreaterThan(5);
    for (const i of icons) expect(i).toMatch(/aria-hidden="true"/);
    for (const [, id] of page.matchAll(/href="#([a-z-]+)"/g)) expect(page).toContain('id="' + id + '"');
  });
});
