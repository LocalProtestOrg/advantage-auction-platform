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
    for (const sel of rules) for (const part of sel.split(',')) expect([sel, part.trim().startsWith('[data-type-scale]')]).toEqual([sel, true]);
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
