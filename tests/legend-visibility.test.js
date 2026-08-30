'use strict';

/**
 * Homepage map key — event STATUS legend zero-count visibility.
 * Rule: a status (Live Now / Ending Soon / Upcoming) shows only when its current count > 0; when all are
 * zero the section (and, if nothing else is visible, the whole key) is hidden. Same logic the page uses.
 */
const { visibleItems, anyVisible } = require('../public/widgets/shared/legend-visibility.js');

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
