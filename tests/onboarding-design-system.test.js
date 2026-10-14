'use strict';

// Phase 6A onboarding design-system unification. Verifies the shared design language exists and that
// the onboarding pages adopt it (consistent CSS, first-screen answers, privacy microcopy, SEO).

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const css = read('public', 'widgets', 'shared', 'onboarding.css');
const becomeSeller = read('public', 'become-seller.html');
const appraiser = read('public', 'appraiser-membership.html');

const links = (h) => /<link[^>]+widgets\/shared\/onboarding\.css/.test(h);
const hasThreeAnswers = (h) => /What am I doing\?/.test(h) && /What happens next\?/.test(h) && /Will my info be public\?/.test(h);

describe('onboarding.css — the shared design system exists with the core components', () => {
  test('defines design tokens + reusable components', () => {
    for (const tok of ['--ob-ink', '--ob-accent', '--ob-serif', '--ob-paper']) expect(css).toContain(tok);
    for (const comp of ['.ob-hero', '.ob-answers', '.ob-cta', '.ob-card', '.ob-grid', '.ob-incl', '.ob-steps', '.ob-callout', '.ob-privacy', '.ob-faq', '.ob-form', '.ob-foot']) {
      expect(css).toContain(comp);
    }
  });
  test('is accessible + responsive (focus-visible, reduced motion, mobile grid collapse)', () => {
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/prefers-reduced-motion/);
    expect(css).toMatch(/@media\(max-width:640px\)[\s\S]*grid-template-columns:1fr/);
  });
});

// Every Railway onboarding page (Phase 6B) — all must adopt the shared design system.
// (promote-estate-sale / create-estate-sale / estate-sale-welcome were archived 2026-10-12 when the
// Estate Sale Promotion was disabled — see tests/estate-sale-promotion-disabled.test.js.)
const ONBOARDING_PAGES = [
  'become-seller', 'appraiser-membership',
  'appraiser-welcome', 'after-estate-sale', 'sign-agreement',
  'verify-documents', 'seller-faq', 'seller-pilot', 'how-sellers-get-paid', 'seller-create',
];

describe('every Railway onboarding page adopts the shared system', () => {
  test.each(ONBOARDING_PAGES)('%s links onboarding.css, loads its heading face, and uses class="ob-body"', (name) => {
    const h = read('public', name + '.html');
    expect(links(h)).toBe(true);
    // Owner decision 2026-09-27: pages on the shared type scale (css/typography.css) use Quicksand for headings
    // too (--ob-serif is re-pointed there); pages not yet migrated keep the Fraunces display face.
    if (/<html[^>]*data-type-scale/.test(h)) {
      expect(h).toMatch(/family=Quicksand/);
      expect(h).not.toMatch(/family=Fraunces/);
    } else {
      expect(h).toMatch(/family=Fraunces/);
    }
    expect(h).toMatch(/<body[^>]*\bob-body\b/);
  });
});

describe('ADVANTAGE_DESIGN_SYSTEM.md — the governing design document', () => {
  const md = read('docs', 'design', 'ADVANTAGE_DESIGN_SYSTEM.md');
  test('exists and covers the required standards', () => {
    for (const s of ['Brand philosophy', 'Stupid Easy', 'Trust-first', 'Mobile-first', 'Accessibility',
      'Typography', 'Spacing', 'Colors', 'Hero pattern', 'Three-question strip', 'Why Advantage.Bid',
      'Cards', 'Forms', 'Buttons', 'Tables', 'Callouts', 'FAQ', 'Progress indicators', 'Empty states',
      'Loading states', 'Dashboard', 'Privacy messaging', 'Microcopy', 'terminology', 'SEO', 'Email']) {
      expect(md).toMatch(new RegExp(s, 'i'));
    }
  });
});

describe('the first screen answers the three questions', () => {
  test('Become Seller carries the three-answer strip', () => {
    expect(hasThreeAnswers(becomeSeller)).toBe(true);
    expect(becomeSeller).toMatch(/class="ob-answers"/);
  });
});

describe('privacy microcopy — private sellers', () => {
  test('Become Seller states the personal profile stays private (not a searchable profile)', () => {
    expect(becomeSeller).toMatch(/ob-privacy/);
    expect(becomeSeller).toMatch(/profile stays private/i);
    expect(becomeSeller).toMatch(/never published as a searchable profile/i);
  });
});

