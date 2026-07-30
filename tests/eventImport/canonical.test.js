'use strict';

const c = require('../../src/services/eventImport/normalize/canonical');

describe('sanitizer primitives', () => {
  test('text preserves punctuation, collapses whitespace, strips control chars, clamps', () => {
    expect(c.text('  Smith & Sons - Estate (2026)!  ')).toBe('Smith & Sons - Estate (2026)!');
    expect(c.text('ab\tc\n d')).toBe('a b c d');
    expect(c.text('abcdef', 3)).toBe('abc');
  });
  test('plainText strips HTML', () => { expect(c.plainText('<b>Hi</b> <i>there</i>')).toBe('Hi there'); });
  test('url only accepts http(s)', () => {
    expect(c.url('https://x.com/a')).toBe('https://x.com/a');
    expect(c.url('javascript:alert(1)')).toBeNull();
    expect(c.url('not a url')).toBeNull();
  });
  test('email/phone validation', () => {
    expect(c.email(' A@B.CO ')).toBe('a@b.co');
    expect(c.email('nope')).toBeNull();
    expect(c.phone('(734) 555-1212')).toBe('7345551212');
    expect(c.phone('123')).toBeNull();
  });
  test('boolOrNull / intOrNull / floatInRange', () => {
    expect(c.boolOrNull('yes')).toBe(true); expect(c.boolOrNull('0')).toBe(false); expect(c.boolOrNull('maybe')).toBeNull();
    expect(c.intOrNull('42x')).toBe(42); expect(c.intOrNull('x')).toBeNull();
    expect(c.floatInRange('29.7', -90, 90)).toBe(29.7); expect(c.floatInRange('200', -90, 90)).toBeNull();
  });
  test('stringArray splits + cleans', () => { expect(c.stringArray('a; b|c ,d')).toEqual(['a', 'b', 'c', 'd']); });
  test('normalizeUrlForHash strips utm/fragment/trailing slash + lowercases host', () => {
    expect(c.normalizeUrlForHash('https://WWW.Example.com/Sale/?utm_source=x&id=5#frag'))
      .toBe('https://www.example.com/sale/?id=5'.replace(/\/$/, ''));
  });
});

describe('deriveEndAt — the never-expire guard', () => {
  const NY = 'America/New_York';
  test('explicit valid end_at wins', () => {
    expect(c.deriveEndAt({ start_at: '2026-08-01T14:00:00Z', end_at: '2026-08-01T20:00:00Z', timezone: NY })).toBe('2026-08-01T20:00:00.000Z');
  });
  test('explicit end before start is ignored → single-day end', () => {
    expect(c.deriveEndAt({ start_at: '2026-08-01T14:00:00Z', end_at: '2026-07-01T00:00:00Z', timezone: NY })).toBe('2026-08-02T03:59:00.000Z');
  });
  test('auction final_close', () => {
    expect(c.deriveEndAt({ start_at: '2026-08-01T14:00:00Z', closing_schedule: { final_close: '2026-08-03T22:00:00Z' }, timezone: NY })).toBe('2026-08-03T22:00:00.000Z');
  });
  test('multi-day end_date → 23:59 local that day', () => {
    expect(c.deriveEndAt({ start_at: '2026-08-01T14:00:00Z', end_date: '2026-08-03', timezone: NY })).toBe('2026-08-04T03:59:00.000Z');
  });
  test('single-day is DST-aware (EST 04:59Z winter, EDT 03:59Z summer)', () => {
    expect(c.deriveEndAt({ start_at: '2026-01-15T14:00:00Z', timezone: NY })).toBe('2026-01-16T04:59:00.000Z');
    expect(c.deriveEndAt({ start_at: '2026-08-15T14:00:00Z', timezone: NY })).toBe('2026-08-16T03:59:00.000Z');
  });
  test('no start_at → null (unpublishable)', () => { expect(c.deriveEndAt({ start_at: null })).toBeNull(); });
});

describe('sanitizeCanonical + hashing', () => {
  test('assembles a canonical event and ALWAYS fills end_at', () => {
    const e = c.sanitizeCanonical({ title: ' Estate Sale ', start_at: '2026-08-01T14:00:00Z', timezone: 'America/New_York', city: 'Adrian', state: 'MI', sale_type: 'ESTATE_SALE', buyer_premium_bps: '1500', shipping_available: 'yes' });
    expect(e.title).toBe('Estate Sale');
    expect(e.sale_type).toBe('estate_sale');
    expect(e.buyer_premium_bps).toBe(1500);
    expect(e.shipping_available).toBe(true);
    expect(e.end_at).toBe('2026-08-02T03:59:00.000Z'); // derived
  });
  test('invalid enum / bad image url dropped', () => {
    const e = c.sanitizeCanonical({ title: 'x', start_at: '2026-08-01T14:00:00Z', sale_type: 'bogus', images: [{ url: 'https://ok/1.jpg' }, { url: 'javascript:x' }] });
    expect(e.sale_type).toBeNull();
    expect(e.images).toEqual([{ url: 'https://ok/1.jpg', position: 0, caption: null }]);
  });
  test('contentHash stable + sensitive to a meaningful change', () => {
    const base = { title: 'A', start_at: '2026-08-01T14:00:00Z', timezone: 'America/New_York', city: 'X', state: 'MI' };
    const h1 = c.contentHash(c.sanitizeCanonical(base));
    const h2 = c.contentHash(c.sanitizeCanonical({ ...base }));
    const h3 = c.contentHash(c.sanitizeCanonical({ ...base, title: 'B' }));
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});
