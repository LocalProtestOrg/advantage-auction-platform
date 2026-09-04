'use strict';

/**
 * Homepage map key — event STATUS legend zero-count visibility.
 * Rule: a status (Live Now / Ending Soon / Upcoming) shows only when its current count > 0; when all are
 * zero the section (and, if nothing else is visible, the whole key) is hidden. Same logic the page uses.
 */
const { visibleItems, anyVisible, keepUnlessZero, isAuthoritativeZero, isKnownCount } = require('../public/widgets/shared/legend-visibility.js');

// Mirrors index.html MP_EVENTS (the three status legend items).
const STATUS = [{ key: 'live', label: 'Live Now' }, { key: 'ending', label: 'Ending Soon' }, { key: 'coming', label: 'Upcoming' }];
const shown = (counts) => visibleItems(STATUS, counts).map((i) => i.label);

describe('status legend zero-count visibility (owner cases 1–6)', () => {
  test('CASE 1 — 2/3/4 → all three render', () => {
    expect(shown({ live: 2, ending: 3, coming: 4 })).toEqual(['Live Now', 'Ending Soon', 'Upcoming']);
  });
  test('CASE 2 — 0/3/4 → only Ending Soon + Upcoming', () => {
    expect(shown({ live: 0, ending: 3, coming: 4 })).toEqual(['Ending Soon', 'Upcoming']);
  });
  test('CASE 3 — 2/0/4 → only Live Now + Upcoming', () => {
    expect(shown({ live: 2, ending: 0, coming: 4 })).toEqual(['Live Now', 'Upcoming']);
  });
  test('CASE 4 — 2/3/0 → only Live Now + Ending Soon', () => {
    expect(shown({ live: 2, ending: 3, coming: 0 })).toEqual(['Live Now', 'Ending Soon']);
  });
  test('CASE 5 — 0/0/4 → only Upcoming', () => {
    expect(shown({ live: 0, ending: 0, coming: 4 })).toEqual(['Upcoming']);
  });
  test('CASE 6 — 0/0/0 → nothing renders; section/key is hidden', () => {
    expect(shown({ live: 0, ending: 0, coming: 0 })).toEqual([]);
    expect(anyVisible(STATUS, { live: 0, ending: 0, coming: 0 })).toBe(false);
  });
});

describe('robustness (no fake/inflated counts)', () => {
  test('missing / undefined / negative counts are treated as not visible', () => {
    expect(shown({})).toEqual([]);
    expect(shown({ live: undefined, ending: null, coming: -1 })).toEqual([]);
  });
  test('a function count source works (mirrors the page passing row.n)', () => {
    const rows = [{ key: 'a', n: 0 }, { key: 'b', n: 5 }];
    expect(visibleItems(rows, (r) => r.n).map((r) => r.key)).toEqual(['b']);
  });
  test('anyVisible drives the whole-key hide', () => {
    expect(anyVisible(STATUS, { live: 1, ending: 0, coming: 0 })).toBe(true);
    expect(anyVisible(STATUS, { live: 0, ending: 0, coming: 0 })).toBe(false);
  });
});

// keepUnlessZero — the §3-correct predicate for surfaces that may render before data loads
// (e.g. the search category dropdown). Hide ONLY an authoritative zero; never a false zero.
describe('keepUnlessZero (unknown is NOT an authoritative zero)', () => {
  test('authoritative zeros are hidden: 0, "0", negative', () => {
    expect(keepUnlessZero(0)).toBe(false);
    expect(keepUnlessZero('0')).toBe(false);
    expect(keepUnlessZero(-1)).toBe(false);
    expect(isAuthoritativeZero(0)).toBe(true);
    expect(isAuthoritativeZero('0')).toBe(true);
  });
  test('positive counts are shown: number and numeric string', () => {
    expect(keepUnlessZero(3)).toBe(true);
    expect(keepUnlessZero('12')).toBe(true);
    expect(keepUnlessZero(2.5)).toBe(true);
  });
  test('UNKNOWN / loading / API-error are kept (not falsely hidden as zero)', () => {
    expect(keepUnlessZero(null)).toBe(true);
    expect(keepUnlessZero(undefined)).toBe(true);
    expect(keepUnlessZero('')).toBe(true);
    expect(keepUnlessZero(NaN)).toBe(true);
    expect(keepUnlessZero('abc')).toBe(true);
    expect(isKnownCount(undefined)).toBe(false);
    expect(isAuthoritativeZero(undefined)).toBe(false);   // not authoritative → never hidden as zero
  });
});

// Mirrors search.html loadCategories(): a category option renders only when its lot_count is not an
// authoritative zero. Same shared rule; "All Categories" default is added separately (never filtered).
describe('search category dropdown zero-hiding', () => {
  const optionsFor = (cats) => cats.filter((c) => keepUnlessZero(c.lot_count)).map((c) => c.category);
  test('drops zero-lot categories, keeps positive', () => {
    const cats = [{ category: 'Furniture', lot_count: 12 }, { category: 'Coins', lot_count: 0 }, { category: 'Art', lot_count: 3 }];
    expect(optionsFor(cats)).toEqual(['Furniture', 'Art']);
  });
  test('numeric-string counts handled', () => {
    expect(optionsFor([{ category: 'A', lot_count: '0' }, { category: 'B', lot_count: '5' }])).toEqual(['B']);
  });
  test('unknown lot_count is kept (never hidden as a false zero)', () => {
    expect(optionsFor([{ category: 'A', lot_count: undefined }, { category: 'B', lot_count: null }])).toEqual(['A', 'B']);
  });
  test('all zero → no category options (only the untouched All default would remain)', () => {
    expect(optionsFor([{ category: 'A', lot_count: 0 }, { category: 'B', lot_count: 0 }])).toEqual([]);
  });
});
