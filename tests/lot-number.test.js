'use strict';

/**
 * Alphanumeric (A/B) catalog lot numbers — parsing + deterministic catalog ordering.
 * Guards the real-world auction-house pattern: 98, 99, 100, 100A, 100B, 101 (NOT lexical 1,10,100,11).
 */
const { parseLotNumber, displayFor, compareCatalog, sortCatalog } = require('../src/lib/lotNumber');

describe('parseLotNumber', () => {
  test('plain number', () => expect(parseLotNumber('100')).toEqual({ base: 100, suffix: '', display: '100' }));
  test('suffix lot (lowercase → uppercase display)', () => expect(parseLotNumber('100a')).toEqual({ base: 100, suffix: 'a', display: '100A' }));
  test('trims + normalizes whitespace', () => expect(parseLotNumber('  11B ')).toEqual({ base: 11, suffix: 'b', display: '11B' }));
  test('base is the numeric part, never the whole string', () => {
    expect(parseLotNumber('100a').base).toBe(100);   // NOT 100a→NaN, NOT dropped
    expect(parseLotNumber('99e').base).toBe(99);
  });
});

describe('displayFor', () => {
  test('prefers lot_number_display', () => expect(displayFor({ lot_number: 100, lot_number_display: '100A' })).toBe('100A'));
  test('falls back to integer when display missing/blank', () => {
    expect(displayFor({ lot_number: 42, lot_number_display: null })).toBe('42');
    expect(displayFor({ lot_number: 42, lot_number_display: '' })).toBe('42');
  });
});

describe('catalog ordering', () => {
  const mk = (n, d) => ({ lot_number: n, lot_number_display: d });
  test('A/B lots sort immediately after their base, before the next number', () => {
    const input = [mk(101, '101'), mk(100, '100'), mk(100, '100B'), mk(99, '99'), mk(100, '100A'), mk(98, '98')];
    expect(sortCatalog(input).map((l) => l.lot_number_display)).toEqual(['98', '99', '100', '100A', '100B', '101']);
  });
  test('full a–e suffix run orders correctly', () => {
    const input = [mk(11, '11E'), mk(12, '12'), mk(11, '11'), mk(11, '11C'), mk(11, '11A'), mk(11, '11D'), mk(11, '11B')];
    expect(sortCatalog(input).map((l) => l.lot_number_display)).toEqual(['11', '11A', '11B', '11C', '11D', '11E', '12']);
  });
  test('numeric ordering is NOT lexical (10 does not sort between 1 and 2)', () => {
    const input = [mk(1, '1'), mk(10, '10'), mk(100, '100'), mk(2, '2'), mk(11, '11')];
    expect(sortCatalog(input).map((l) => l.lot_number)).toEqual([1, 2, 10, 11, 100]);
  });
  test('parseInt collision is impossible: 100 and 100A are distinct, ordered 100 then 100A', () => {
    const input = [mk(100, '100A'), mk(100, '100')];
    const out = sortCatalog(input).map((l) => l.lot_number_display);
    expect(out).toEqual(['100', '100A']);
    expect(new Set(out).size).toBe(2); // never collapsed to one
  });
  test('compareCatalog puts null lot_number last', () => {
    expect(compareCatalog({ lot_number: 5, lot_number_display: '5' }, { lot_number: null, lot_number_display: 'X' })).toBeLessThan(0);
  });
});
