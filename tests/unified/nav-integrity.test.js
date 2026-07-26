'use strict';

/**
 * Navigation Integrity — guards against the "button doesn't advance" class of defect:
 * dead same-page anchors on primary CTAs, and identical CTA labels that scroll instead of advancing.
 */

const fs = require('fs');
const path = require('path');
const pubDir = path.join(__dirname, '..', '..', 'public');
const read = (f) => fs.readFileSync(path.join(pubDir, f), 'utf8');
const htmlFiles = fs.readdirSync(pubDir).filter((f) => f.endsWith('.html'));

describe('the Bidding Guide CTA advances to the real buying guide (not a dead seller anchor)', () => {
  test('no page links to the nonexistent /how-it-works.html#buyers anchor', () => {
    for (const f of htmlFiles) {
      expect(read(f)).not.toContain('how-it-works.html#buyers');
    }
  });
  test('the buyer-faq "Bidding Guide" CTA points at /how-to-buy.html', () => {
    const faq = read('buyer-faq.html');
    expect(faq).toMatch(/href="\/how-to-buy\.html"[^>]*>Bidding Guide/);
  });
});

describe('same-page anchor CTAs only point at anchors that exist', () => {
  // For each page, every href="#id" (non-empty) must have a matching id/name on that page.
  test('no dead in-page anchors', () => {
    const dead = [];
    for (const f of htmlFiles) {
      const html = read(f);
      const anchors = (html.match(/href="#([a-zA-Z][\w-]*)"/g) || [])
        .map((m) => m.replace(/href="#/, '').replace(/"$/, ''));
      for (const a of anchors) {
        if (!new RegExp('id="' + a + '"|name="' + a + '"').test(html)) dead.push(f + ' → #' + a);
      }
    }
    expect(dead).toEqual([]);
  });
});

describe('marketing seller CTAs advance into onboarding (no scroll-loop)', () => {
  const sellerPages = ['start-selling.html', 'how-it-works.html', 'how-sellers-get-paid.html',
    'after-estate-sale.html', 'downsizing-liquidation.html'];
  test('every primary "Start Selling"/"Create Seller Account" CTA → /become-seller.html', () => {
    for (const f of sellerPages) {
      const html = read(f);
      // the page must contain at least one become-seller CTA and never a href="#"-only primary CTA
      expect(html).toContain('/become-seller.html');
      expect(html).not.toMatch(/class="[^"]*(hero-primary|cta-primary|header-cta)[^"]*"[^>]*href="#"/);
      expect(html).not.toMatch(/href="#"[^>]*class="[^"]*(hero-primary|cta-primary|header-cta)/);
    }
  });
});
