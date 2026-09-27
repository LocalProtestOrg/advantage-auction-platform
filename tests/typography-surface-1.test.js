'use strict';

/**
 * Typography system, surface 1 (public marketing pages). Tokens live in ONE file (public/css/typography.css),
 * pages opt in explicitly, and the migrated pages use the tokens instead of hard-coded sizes.
 */

const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', 'public');
const read = (...p) => fs.readFileSync(path.join(PUB, ...p), 'utf8');
const codemod = require('../scripts/typography-codemod');

const SURFACE_1 = ['after-estate-sale.html', 'assisted-service.html', 'buyer-faq.html', 'downsizing-liquidation.html', 'faq.html',
  'free-business-listing.html', 'how-it-works.html', 'how-sellers-get-paid.html', 'how-to-buy.html', 'professional-sellers.html',
  'seller-faq.html', 'seller-pilot.html', 'shipping-available.html', 'start-selling.html'];

describe('typography tokens', () => {
  const css = read('css', 'typography.css');
  test('the approved scale, in rem, with the root size untouched', () => {
    for (const [tok, v] of [['caption', '1.125rem'], ['secondary', '1.25rem'], ['control', '1.375rem'], ['body', '1.5rem']]) {
      expect(css).toMatch(new RegExp('--fs-' + tok + ':\\s*' + v.replace('.', '\\.') + ';'));
    }
    expect(css).toMatch(/--fs-h1:\s*clamp\(/);
    expect(css).not.toMatch(/(^|\s)html\s*\{[^}]*font-size/);
    expect(css).not.toMatch(/font-size:\s*[\d.]+px/);                 // every size scales with the browser setting
  });
  test('rules for shared components only apply to opted-in pages', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^{}]*\}/g).map((r) => r.split('{')[0].trim()).filter((s) => s && !s.startsWith('@') && s !== ':root');
    for (const sel of rules) for (const part of sel.split(',')) expect([sel, /^(html)?\[data-type-scale\]/.test(part.trim())]).toEqual([sel, true]);
  });
});

describe('surface 1 pages', () => {
  test.each(SURFACE_1)('%s opts in once and uses tokens instead of hard-coded sizes', (f) => {
    const h = read(f);
    expect(h).toMatch(/<html[^>]*data-type-scale/);
    expect((h.match(/href="\/css\/typography\.css"/g) || []).length).toBe(1);
    expect((h.match(/family=Quicksand/g) || []).length).toBe(1);
    const styles = (h.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join('\n');
    const report = { changes: [], manual: [], kept: [] };
    codemod.rewriteCss(styles, f, report);
    expect(report.changes).toEqual([]);                             // nothing left to migrate
    expect(report.manual).toEqual([]);
  });
  test('pages outside the surface are untouched', () => {
    for (const f of ['index.html', 'auction-view.html', 'lot.html', 'app.html', 'admin/sales.html']) {
      expect([f, /data-type-scale/.test(read(f))]).toEqual([f, false]);
    }
  });
});

describe('owner decisions 2026-09-27: Quicksand, weight 500, directory colours', () => {
  const css = read('css', 'typography.css');
  test('body text is Quicksand at weight 500; onboarding headings are re-pointed to Quicksand', () => {
    expect(css).toMatch(/--fw-body:\s*500;/);
    expect(css).toMatch(/--font-body:\s*'Quicksand'/);
    expect(css).toMatch(/--ob-serif:\s*var\(--font-display\);/);
  });
  test('links and blue buttons use #006FBB, red CTAs #D9534F, on opted-in pages only', () => {
    expect(css).toMatch(/html\[data-type-scale\] \{[\s\S]*--blue:\s*#006fbb;[\s\S]*--brand-red:\s*#d9534f;/);
    expect(css).toMatch(/\.adv-pubnav \.btn-header-cta \{[^}]*background: var\(--brand-red\); color: #fff;/);
  });
  test('white on red stays at the WCAG large-text size on phones (19px bold)', () => {
    expect(css).toMatch(/@media \(max-width: 480px\)[\s\S]*\.adv-pubnav \.btn-header-cta \{ font-size: 1\.1875rem;/);
  });
  test('How It Works: text in Quicksand, drawn illustrations keep their original faces and accent', () => {
    const h = read('how-it-works.html');
    expect(h).toMatch(/--se-sans:\s*var\(--font-body/);
    expect(h).toMatch(/--se-ill-sans:\s*-apple-system/);
    expect(h).toMatch(/--se-ill-display: 'Fraunces'/);
    expect(h).toMatch(/--se-ill-accent: #2563eb;/);
    expect(h).toMatch(/\.mk-field \{[^}]*font-family: var\(--se-ill-sans\)/);
    expect(h).toMatch(/:where\(\[class\*="mk-"\][^)]*\) \{ font-weight: 400; font-family: var\(--se-ill-sans\); \}/);
  });
  test('no migrated page loads Fraunces except How It Works, which needs it for the illustrations', () => {
    for (const f of SURFACE_1.filter((x) => x !== 'how-it-works.html')) expect([f, /family=Fraunces/.test(read(f))]).toEqual([f, false]);
  });
  test('the Professional Sellers hero note is readable on navy', () => {
    const h = read('professional-sellers.html');
    expect(h).toMatch(/\.hero-note \{ color:#cbd5e1;/);
    expect(h).not.toMatch(/\.hero-note \{ color:#64748b;/);
  });
  test('on navy sections, the wordmark, outline buttons and labels stay light', () => {
    expect(css).toMatch(/\.ob-body \.adv-pubnav \.brand \{ color: #fff; \}/);
    expect(css).toMatch(/\.ob-body a\.btn-hero-secondary, \[data-type-scale\] \.ob-body a\.btn-cta-outline \{ color: #e2e8f0; \}/);
    for (const [f, re] of [['after-estate-sale.html', /\.article-meta \{[^}]*color: #cbd5e1;/], ['seller-pilot.html', /\.hero-stat-label \{[^}]*color: #cbd5e1;/],
      ['start-selling.html', /\.hero-card-title \{[^}]*color: #cbd5e1;/]]) expect([f, re.test(read(f))]).toEqual([f, true]);
  });
});

describe('codemod mapping', () => {
  const t = codemod.tokenFor;
  test('reading text, headings, controls and labels map to the right steps', () => {
    expect(t('.who-card p', 13.6)).toBe('var(--fs-body)');
    expect(t('.hero h1', 44)).toBe('var(--fs-h1)');
    expect(t('.step-card h3', 15.2)).toBe('var(--fs-h4)');
    expect(t('.btn-hero-primary', 16)).toBe('var(--fs-control)');
    expect(t('.section-eyebrow', 11.5)).toBe('var(--fs-caption)');
    expect(t('.cta-band p', 16.8)).toBe('var(--fs-body)');
    expect(t('.trust-text', 13.6)).toBe('var(--fs-secondary)');
  });
  test('logos, icons and illustrations keep their size', () => {
    for (const s of ['.brand', '.who-icon', '.step-num', '.mk-label', '.se-frame-url', '.lb-field', '.aud-plus']) expect([s, t(s, 12)]).toEqual([s, null]);
  });
});
