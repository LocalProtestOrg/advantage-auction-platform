'use strict';

/**
 * start-selling.html (Railway-owned; the directory's www.advantage.bid/start-selling is a separate BD page).
 * Owner-approved benefits-first positioning (2026-09-27):
 *   - Leads with "Your auctions. Your brand. More buyers."
 *   - Professional sellers do NOT need a website: the white-label widget on their own site, OR their own
 *     Advantage.Bid business page (the Professional Storefront). Every professional auction also appears on the
 *     Advantage.Bid marketplace (automatic; dual distribution by design).
 *   - Individual and professional messaging are clearly separated; the individual-only claims (no platform fee at
 *     launch, our team publishes) live only in the individual sections.
 */

const fs = require('fs');
const path = require('path');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'start-selling.html'), 'utf8');
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const text = strip(page);
const section = (id) => { const a = page.indexOf('id="' + id + '"'); const s = page.lastIndexOf('<section', a); return strip(page.slice(s, page.indexOf('</section>', a))); };
const meta = (sel) => (page.match(new RegExp('<meta ' + sel + ' content="([^"]*)"')) || [])[1] || '';

describe('start-selling.html: benefits-first, two audiences kept separate', () => {
  test('the hero leads with the approved line and offers both paths', () => {
    expect(page).toMatch(/<h1 id="hero-heading">Your auctions\. <em>Your brand\.<\/em> More buyers\.<\/h1>/);
    expect(page).toMatch(/href="#professional" class="btn-hero-primary"/);
    expect(page).toMatch(/href="#individual" class="btn-hero-secondary"/);
  });

  test('professional sellers do not need a website: widget OR their own business page, plus the marketplace', () => {
    const pro = section('professional');
    expect(pro).toMatch(/You do not need your own website/);
    expect(pro).toMatch(/Already have a website\? Show your auctions on your own site Our white-label widget/);
    expect(pro).toMatch(/No website\? Your own Advantage\.Bid business page/);
    expect(pro).toMatch(/Every professional auction you publish also appears on the Advantage\.Bid marketplace/);
    expect(pro).toMatch(/Bidding, payment and checkout take place on Advantage\.Bid's secure auction pages/);
    for (const h of ['Win more estate contracts', 'Estate sales and online auctions', 'Sell the remaining inventory', 'Your buyer\'s premium', 'No auction software to build']) expect(pro).toContain(h);
    expect(pro).toMatch(/at least 30 lots/);
  });

  test('individual-only claims appear only in individual sections, never in the professional section', () => {
    const pro = section('professional');
    for (const re of [/No seller platform fee/i, /Our team handles publishing/i, /Advantage publishes/i, /~?3% payment processing/i]) expect(pro).not.toMatch(re);
    expect(section('individual')).toMatch(/Our team handles publishing and buyer communication/);
    expect(page).toMatch(/Individual sellers: getting started/);
    expect(page).toMatch(/Individual sellers: common concerns/);
    expect(page).toMatch(/Fees for individual sellers/);
  });

  test('no inaccurate or prohibited claims', () => {
    expect(text).not.toMatch(/nationwide|guarantee|sell-through|website-only|off the marketplace|Buy Now checkout/i);
    expect(text).not.toMatch(/\b(5|12|14)-lot auction/i);          // below the 30-lot minimum
    expect(text).not.toMatch(/(own|export|download) (your |the )?(buyer|customer|bidder) (data|list|contacts)/i);
  });

  test('metadata reflects the new positioning; canonical and social tags preserved', () => {
    expect(page).toMatch(/<link rel="canonical" href="https:\/\/bid\.advantage\.bid\/start-selling\.html" \/>/);
    expect(meta('name="description"')).toMatch(/on your own website or your own Advantage\.Bid business page, and on the Advantage\.Bid marketplace/);
    expect(meta('name="description"')).not.toMatch(/nationwide/i);
    expect(meta('property="og:title"')).toBe('Your auctions. Your brand. More buyers.');
    expect(meta('name="twitter:title"')).toBe('Your auctions. Your brand. More buyers.');
    expect(meta('property="og:url"')).toBe('https://bid.advantage.bid/start-selling.html');
    expect(meta('property="og:image"')).toBe('https://bid.advantage.bid/img/social-card.png');
  });

  test('signup routes preserved: individuals to /become-seller.html, professionals to /become-professional-seller.html', () => {
    expect(page).toMatch(/href="\/become-seller\.html" class="btn-solid teal">Create Seller Account/);
    expect(page).toMatch(/href="\/become-professional-seller\.html" class="btn-solid">Become a Professional Seller/);
    expect(page).toMatch(/href="\/become-professional-seller\.html" class="btn-cta-primary"/);
    expect(page).toMatch(/href="\/become-seller\.html" class="btn-cta-outline"/);
  });

  test('accessibility: one h1, sections labelled by existing headings, in-page links resolve', () => {
    expect((page.match(/<h1[\s>]/g) || []).length).toBe(1);
    for (const [, id] of page.matchAll(/aria-labelledby="([^"]+)"/g)) expect(page).toContain('id="' + id + '"');
    for (const [, id] of page.matchAll(/href="#([a-z-]+)"/g)) expect(page).toContain('id="' + id + '"');
  });
});
