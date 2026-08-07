'use strict';

// Phase 6A onboarding design-system unification. Verifies the shared design language exists and that
// the onboarding pages adopt it (consistent CSS, first-screen answers, privacy microcopy, SEO).

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const css = read('public', 'widgets', 'shared', 'onboarding.css');
const becomeSeller = read('public', 'become-seller.html');
const promote = read('public', 'promote-estate-sale.html');
const appraiser = read('public', 'appraiser-membership.html');
const createEs = read('public', 'create-estate-sale.html');

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

describe('every audited onboarding page adopts the shared system', () => {
  test('all four link onboarding.css', () => {
    expect(links(becomeSeller)).toBe(true);
    expect(links(promote)).toBe(true);
    expect(links(appraiser)).toBe(true);
    expect(links(createEs)).toBe(true);
  });
  test('the Fraunces display face is loaded consistently', () => {
    for (const h of [becomeSeller, promote, appraiser, createEs]) expect(h).toMatch(/family=Fraunces/);
  });
});

describe('the first screen answers the three questions', () => {
  test('Become Seller + Promote Estate Sale carry the three-answer strip', () => {
    expect(hasThreeAnswers(becomeSeller)).toBe(true);
    expect(hasThreeAnswers(promote)).toBe(true);
    expect(becomeSeller).toMatch(/class="ob-answers"/);
    expect(promote).toMatch(/class="ob-answers"/);
  });
});

describe('privacy microcopy — private sellers', () => {
  test('Become Seller states the personal profile stays private (not a searchable profile)', () => {
    expect(becomeSeller).toMatch(/ob-privacy/);
    expect(becomeSeller).toMatch(/profile stays private/i);
    expect(becomeSeller).toMatch(/never published as a searchable profile/i);
  });
});

describe('SEO on the indexable public landing (Promote Estate Sale)', () => {
  test('has title, description, canonical, OpenGraph, Twitter card, and JSON-LD (Service + Breadcrumb)', () => {
    expect(promote).toMatch(/<meta name="description"/);
    expect(promote).toMatch(/rel="canonical"/);
    expect(promote).toMatch(/property="og:title"/);
    expect(promote).toMatch(/name="twitter:card"/);
    expect(promote).toMatch(/"@type":"Service"/);
    expect(promote).toMatch(/"@type":"BreadcrumbList"/);
  });
});
