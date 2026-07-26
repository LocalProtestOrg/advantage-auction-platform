'use strict';

/**
 * Final pre-launch navigation + SEO/discoverability audit — regression coverage.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(__dirname, '..', '..', ...p));

describe('navigation dead-ends / loops fixed', () => {
  const shell = read('public', 'widgets', 'shared', 'member-shell.js');
  test('no member-shell CTA points at the broken param-less /auction.html', () => {
    expect(shell).not.toContain('href="/auction.html"');
  });
  test('agreement CTAs resume onboarding (?onboarding=1), not a bare dead-end', () => {
    expect(shell).not.toMatch(/href="\/sign-agreement\.html"[^?]/);
    expect((shell.match(/sign-agreement\.html\?onboarding=1/g) || []).length).toBeGreaterThanOrEqual(3);
  });
  test('admins are not routed through buyer seller-onboarding', () => {
    const sellBody = shell.slice(shell.indexOf('function sellBody'), shell.indexOf('function sellBody') + 900);
    expect(sellBody).toMatch(/role === 'admin'/);
    expect(sellBody).toContain('/admin/moderation.html');
  });
  test('logout is consistent (shell + buyer-nav both land on /)', () => {
    expect(shell).not.toContain("location.href = '/login.html'; });"); // old shell logout target gone
    expect(read('public', 'widgets', 'shared', 'buyer-nav.js')).toContain("location.href = '/'");
  });
  test('invoice back-link goes to the canonical shell Purchases route', () => {
    expect(read('public', 'dashboard', 'invoice.html')).toContain('/app.html#purchases');
  });
  test('seller onboarding completion lands on the canonical shell, not a legacy redirect hop', () => {
    expect(read('public', 'become-seller.html')).not.toContain('/seller-dashboard.html');
    expect(read('public', 'become-seller.html')).toContain("location.href = '/app.html'");
  });
});

describe('SEO — indexing safety (no private page indexable)', () => {
  const robots = read('public', 'robots.txt');
  test('robots.txt disallows the shell + the two financial-page risks + org', () => {
    for (const p of ['/app.html', '/payout-profile.html', '/seller-settlements.html', '/become-seller.html', '/org/', '/admin/', '/api/'])
      expect(robots).toContain('Disallow: ' + p);
  });
  test('AI crawlers are addressed explicitly (allowed on public, blocked on private)', () => {
    for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'])
      expect(robots).toContain('User-agent: ' + bot);
  });
  test('the sitemap is referenced with the canonical host', () => {
    expect(robots).toContain('Sitemap: https://bid.advantage.bid/sitemap.xml');
  });
  test('member/admin pages carry a noindex meta (belt-and-suspenders)', () => {
    for (const f of ['payout-profile.html', 'seller-settlements.html', 'my-bids.html', 'billing.html', 'invoices.html', 'payment.html', 'add-card.html'])
      expect(read('public', f)).toMatch(/name="robots"\s+content="noindex/i);
    for (const f of ['users.html', 'invoices.html', 'settlement-review.html', 'buyers.html', 'invoice-detail.html'])
      expect(read('public', 'admin', f)).toMatch(/name="robots"\s+content="noindex/i);
  });
  test('the public shell page itself remains noindex', () => {
    expect(read('public', 'app.html')).toMatch(/name="robots"\s+content="noindex/i);
  });
});

describe('SEO — structured data + canonicals', () => {
  test('homepage has WebSite + SearchAction (sitelinks search box) and Organization', () => {
    const idx = read('public', 'index.html');
    expect(idx).toContain('"@type": "WebSite"');
    expect(idx).toContain('"SearchAction"');
    expect(idx).toContain('"@type": "Organization"');
  });
  test('FAQ pages emit FAQPage structured data from their own Q&A', () => {
    expect(exists('public', 'widgets', 'shared', 'faq-schema.js')).toBe(true);
    expect(read('public', 'widgets', 'shared', 'faq-schema.js')).toContain("'FAQPage'");
    expect(read('public', 'buyer-faq.html')).toContain('faq-schema.js');
    expect(read('public', 'seller-faq.html')).toContain('faq-schema.js');
  });
  test('legal pages have canonicals', () => {
    for (const f of ['terms.html', 'privacy.html', 'buyer-terms.html'])
      expect(read('public', f)).toContain('rel="canonical"');
    expect(read('public', 'buyer-terms.html')).toMatch(/name="description"/);
  });
});

describe('SEO — sitemap coverage', () => {
  test('sitemap static list includes the newly-covered public pages', () => {
    const server = read('server.js');
    const list = server.slice(server.indexOf('const staticPaths'), server.indexOf('const staticPaths') + 700);
    for (const p of ['/events.html', '/terms.html', '/privacy.html', '/buyer-terms.html'])
      expect(list).toContain("'" + p + "'");
  });
});
