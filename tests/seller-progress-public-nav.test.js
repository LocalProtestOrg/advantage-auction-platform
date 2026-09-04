'use strict';

/**
 * Seller "X of 30" progress (server-authoritative) + public header/navigation centralization.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── PART 1: authoritative X/30 progress ─────────────────────────────────────────
describe('X of 30 progress — server authoritative', () => {
  const lots = read('src', 'routes', 'lots.js');
  test('the seller lot-list endpoint returns a progress object from the server 30-lot constant', () => {
    expect(lots).toMatch(/MIN_LOTS_FOR_SUBMISSION/);
    expect(lots).toMatch(/valid_lot_count:/);
    expect(lots).toMatch(/minimum: MIN_LOTS_FOR_SUBMISSION/);
    expect(lots).toMatch(/meets_minimum:/);
    expect(lots).toMatch(/remaining: Math\.max\(0, MIN_LOTS_FOR_SUBMISSION - validCount\)/);
  });
  test('progress derives from VALID (non-withdrawn) rows only', () => {
    const block = lots.slice(lots.indexOf("/auction/:auctionId/seller"), lots.indexOf('GET /api/lots/auction/:auctionId '));
    expect(block).toMatch(/state != 'withdrawn'/);
    expect(block).toMatch(/validCount = result\.rows\.length/);
  });
  test('progress values at 0/1/29/30/31 (minimum 30; withdrawn excluded by the query)', () => {
    const MIN = require('../src/services/auctionService').MIN_LOTS_FOR_SUBMISSION;
    expect(MIN).toBe(30);
    const state = (c) => ({ meets: c >= MIN, remaining: Math.max(0, MIN - c) });
    expect(state(0)).toEqual({ meets: false, remaining: 30 });
    expect(state(1)).toEqual({ meets: false, remaining: 29 });
    expect(state(29)).toEqual({ meets: false, remaining: 1 });
    expect(state(30)).toEqual({ meets: true, remaining: 0 });
    expect(state(31)).toEqual({ meets: true, remaining: 0 });
  });
  test('lot-builder displays X of 30, refreshes after add, and reads the SERVER count (no client rule)', () => {
    const b = read('public', 'lot-builder.html');
    expect(b).toMatch(/of ' \+ p\.minimum \+ ' lots added/);
    expect(b).toMatch(/refreshProgress\(\)/);
    expect(b).toMatch(/\/api\/lots\/auction\/' \+ auctionId \+ '\/seller/);
    expect(b).toMatch(/aria-live="polite"/); // accessible status region
    // the 30 literal must not be the client's rule — the number comes from p.minimum
    expect(b).not.toMatch(/valid_lot_count >= 30|count >= 30/);
  });
});

// ── PART 2: shared public navigation ────────────────────────────────────────────
describe('shared public-nav widget', () => {
  const nav = read('public', 'widgets', 'shared', 'public-nav.js');
  test('self-mounts a semantic header + nav with aria-label + working mobile toggle', () => {
    expect(nav).toMatch(/document\.createElement\('header'\)/);
    expect(nav).toMatch(/aria-label="Main navigation"/);
    expect(nav).toMatch(/aria-expanded/);
    expect(nav).toMatch(/mobile-open/);
    expect(nav).toMatch(/@media\(max-width:920px\)/); // fallback mobile CSS so the hamburger always works
  });
  test('canonical relative "/" logo; active-state by pathname; professional variant', () => {
    expect(nav).toMatch(/href="\/" class="brand"/);
    expect(nav).toMatch(/aria-current="page"/);
    expect(nav).toMatch(/variant === 'professional'/);
    expect(nav).toMatch(/Sell Professionally/);
  });
  test('no AI/tracking params in the widget', () => {
    expect(nav).not.toMatch(/utm_source=chatgpt|chatgpt\.com|openai|claude\.ai|utm_/i);
  });
});

describe('migrated public pages use the shared widget (no leftover inline header)', () => {
  const migrated = ['faq.html', 'professional-sellers.html', 'free-business-listing.html', 'how-it-works.html', 'start-selling.html', 'how-to-buy.html'];
  migrated.forEach((f) => {
    test(`${f} loads public-nav.js + mount div, and dropped its inline <header>`, () => {
      const h = read('public', f);
      expect(h).toMatch(/data-adv-public-nav/);
      expect(h).toMatch(/widgets\/shared\/public-nav\.js/);
      expect(h).not.toMatch(/<header>\s*<div class="header-inner">/); // old inline header removed
    });
  });
  test('professional pages request the professional variant', () => {
    expect(read('public', 'professional-sellers.html')).toMatch(/data-variant="professional"/);
    expect(read('public', 'free-business-listing.html')).toMatch(/data-variant="professional"/);
  });
});

describe('canonical-domain hygiene: no brand/logo points to the www host', () => {
  // Established pattern: marketing content pages use relative "/"; auth/event surfaces intentionally link
  // the brand to the APEX marketing site (https://advantage.bid — enforced by brand-link.test). The only
  // genuine inconsistency was a www. host, which must not appear on any brand link.
  test('no public page uses https://www.advantage.bid on a brand link', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'public')).filter((f) => f.endsWith('.html'));
    const offenders = files.filter((f) => /class="brand" href="https:\/\/www\.advantage\.bid/.test(read('public', f)));
    expect(offenders).toEqual([]);
  });
});

describe('clean-link SOP across migrated pages', () => {
  test('no AI/tracking attribution in migrated pages', () => {
    ['faq.html', 'professional-sellers.html', 'free-business-listing.html', 'how-it-works.html', 'start-selling.html', 'how-to-buy.html'].forEach((f) => {
      expect(read('public', f)).not.toMatch(/utm_source=chatgpt|chatgpt\.com|openai|claude\.ai/i);
    });
  });
});
