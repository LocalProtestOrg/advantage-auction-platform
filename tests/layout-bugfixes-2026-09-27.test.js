'use strict';

/**
 * Layout bugs found in the typography audit (2026-09-27), fixed independently of any type-size change:
 *   1. Member dashboard (app.html shell) wider than a phone screen: a plain 1fr grid track grew to its widest child.
 *   2. Sales & Marketing Toolbox: the Prospects table pushed the whole page sideways on a phone.
 *   3. Shared public nav: the header CTA used an undefined class (.btn-cta) and rendered as a plain link.
 *   4. Shared public nav on 10 pages: marketplace-components.js bound a second toggle to the same menu button, so a
 *      tap opened and immediately closed the mobile menu.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'public', ...p), 'utf8');

describe('1. member dashboard fits a phone screen', () => {
  const css = read('widgets', 'shared', 'advantage-ds.css');
  test('grid tracks may shrink below their content (minmax(0,1fr)) on desktop and mobile', () => {
    expect(css).toMatch(/grid-template-columns: var\(--sidebar-w\) minmax\(0,1fr\);/);
    expect(css).toMatch(/\.adv-app \{ grid-template-columns:minmax\(0,1fr\); grid-template-areas:"header" "main"; \}/);
    expect(css).not.toMatch(/grid-template-columns:\s*1fr;\s*grid-template-areas:"header"/);
  });
  test('header and main can shrink, and the mobile header wraps instead of widening the page', () => {
    expect(css).toMatch(/\.adv-header \{[^}]*min-width:0; \}/);
    expect(css).toMatch(/\.adv-main \{ grid-area:main; padding:22px; max-width:1180px; min-width:0; \}/);
    expect(css).toMatch(/@media \(max-width: 860px\) \{[\s\S]*\.adv-header \{ flex-wrap:wrap;/);
  });
});

describe('2. Sales Toolbox tables scroll in their own container', () => {
  const html = read('admin', 'sales.html');
  test('the Prospects table sits inside a focusable, labelled horizontal scroll region', () => {
    expect(html).toMatch(/<div class="table-scroll" role="region" aria-label="Prospects table" tabindex="0">\s*<table>/);
    expect(html).toMatch(/\.table-scroll\{overflow-x:auto;/);
  });
  test('the prospects body id the page script renders into is unchanged', () => {
    expect(html).toMatch(/<tbody id="prospects-body"><\/tbody>/);
  });
});

describe('3 + 4. shared public nav', () => {
  const nav = read('widgets', 'shared', 'public-nav.js');
  test('the header CTA uses the styled .btn-header-cta class, with a self-contained fallback style', () => {
    expect(nav).toMatch(/<a class="btn-header-cta" href="/);
    expect(nav).not.toMatch(/class="btn-cta"/);
    expect(nav).toMatch(/\.adv-pubnav \.btn-header-cta\{display:inline-block;background:#d62828;color:#fff;/);
    expect(read('marketplace.css')).toMatch(/\.btn-header-cta \{/);
  });
  test('only one script toggles the shared nav menu', () => {
    const mc = read('marketplace-components.js');
    expect(mc).toMatch(/if \(!btn \|\| !nav \|\| btn\.classList\.contains\('adv-pubnav-toggle'\)\) return;/);
    expect(nav).toMatch(/class="mobile-menu-btn adv-pubnav-toggle"/);
    expect(nav).toMatch(/btn\.addEventListener\('click', function \(\) \{\s*var open = nav\.classList\.toggle\('mobile-open'\);/);
  });
});
