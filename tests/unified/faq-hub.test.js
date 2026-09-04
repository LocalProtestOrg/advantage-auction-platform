'use strict';

/**
 * Unified FAQ / Help Center hub + navigation consistency.
 */

const fs = require('fs');
const path = require('path');
const pubDir = path.join(__dirname, '..', '..', 'public');
const read = (f) => fs.readFileSync(path.join(pubDir, f), 'utf8');

describe('unified FAQ hub (/faq.html)', () => {
  const faq = read('faq.html');
  test('exists with proper SEO (title, description, canonical, single H1)', () => {
    expect(faq).toContain('<title>Help Center &amp; FAQ - Advantage.Bid</title>');
    expect(faq).toMatch(/name="description"/);
    expect(faq).toContain('rel="canonical" href="https://bid.advantage.bid/faq.html"');
    expect((faq.match(/<h1[ >]/g) || []).length).toBe(1);
  });
  test('routes buyers and sellers to their FAQs (two clear paths)', () => {
    expect(faq).toContain('href="/buyer-faq.html"');
    expect(faq).toContain('href="/seller-faq.html"');
  });
  test('emits FAQPage structured data from real Q&A', () => {
    expect(faq).toContain('faq-schema.js');
    expect((faq.match(/<details class="faq-item">/g) || []).length).toBeGreaterThanOrEqual(4);
  });
  test('is indexable (not noindex) and its anchors all resolve', () => {
    expect(faq).not.toMatch(/name="robots"[^>]*noindex/);
    const anchors = (faq.match(/href="#([\w-]+)"/g) || []).map((m) => m.slice(7, -1));
    for (const a of anchors) expect(new RegExp('id="' + a + '"').test(faq)).toBe(true);
  });
});

describe('navigation consistency — one FAQ item', () => {
  test('marketing headers link a single "FAQ" → /faq.html (no split Buyer/Seller FAQ nav)', () => {
    // The shared public-nav widget provides the single FAQ link for migrated pages; the rest still inline it.
    const navWidget = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'widgets', 'shared', 'public-nav.js'), 'utf8');
    expect(navWidget).toContain("href: '/faq.html'");
    expect(navWidget).not.toMatch(/Seller FAQ|Buyer FAQ/);
    for (const f of ['how-to-buy.html', 'start-selling.html', 'how-it-works.html', 'seller-faq.html', 'buyer-faq.html']) {
      const html = read(f);
      if (html.includes('data-adv-public-nav')) {
        expect(html).toContain('widgets/shared/public-nav.js'); // FAQ link comes from the shared widget
      } else {
        const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
        expect(header).toContain('href="/faq.html"');
      }
      expect(html).not.toMatch(/nav-link[^"]*">Seller FAQ<\/a>/);
      expect(html).not.toMatch(/nav-link[^"]*">Buyer FAQ<\/a>/);
    }
  });
  test('/faq.html is in the sitemap static list', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const list = server.slice(server.indexOf('const staticPaths'), server.indexOf('const staticPaths') + 800);
    expect(list).toContain("'/faq.html'");
  });
});
