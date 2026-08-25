'use strict';

/** Signed one-click unsubscribe tokens: round-trip, tamper rejection, opaque payload. */
const token = require('../src/lib/followerEmailToken');

const U = '11111111-1111-4111-8111-111111111111';
const S = '22222222-2222-4222-8222-222222222222';

describe('followerEmailToken', () => {
  test('sign → verify round-trips the (userId, sellerId) pair', () => {
    const t = token.sign(U, S);
    expect(typeof t).toBe('string');
    expect(t).toContain('.');
    expect(token.verify(t)).toEqual({ userId: U, sellerId: S });
  });
  test('a tampered signature is rejected', () => {
    const t = token.sign(U, S);
    expect(token.verify(t.slice(0, -3) + 'zzz')).toBeNull();
  });
  test('a tampered payload is rejected', () => {
    const t = token.sign(U, S);
    const [, sig] = t.split('.');
    const forged = Buffer.from(`${U}:33333333-3333-4333-8333-333333333333`).toString('base64').replace(/=+$/, '') + '.' + sig;
    expect(token.verify(forged)).toBeNull();
  });
  test('garbage / empty tokens return null (never throw)', () => {
    expect(token.verify('')).toBeNull();
    expect(token.verify(null)).toBeNull();
    expect(token.verify('nodot')).toBeNull();
    expect(token.verify('a.b.c')).toBeNull();
  });
  test('the token body does not contain a raw email address', () => {
    const t = token.sign(U, S);
    expect(t).not.toMatch(/@/);
  });
});
