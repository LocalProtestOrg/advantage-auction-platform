'use strict';

/**
 * Canonical hostname redirect (www.bid.advantage.bid → bid.advantage.bid).
 * Locks in: exact-alias-only matching (no loop, no over-broad redirect), a FIXED destination
 * host (no open redirect / Host-header injection), path+query preservation, and 308.
 */

const { canonicalHostRedirect, CANONICAL_HOST } = require('../src/middleware/canonicalHost');

function run(hostname, originalUrl) {
  const req = { hostname, originalUrl };
  const res = { redirect: jest.fn() };
  const next = jest.fn();
  canonicalHostRedirect(req, res, next);
  return { res, next };
}

describe('canonicalHostRedirect', () => {
  test('redirects the www.bid alias with 308 to the canonical host, path+query preserved', () => {
    const { res, next } = run('www.bid.advantage.bid', '/auction/123?x=1&company=abc');
    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(308, 'https://bid.advantage.bid/auction/123?x=1&company=abc');
  });

  test('preserves encoded paths', () => {
    const { res } = run('www.bid.advantage.bid', '/lot/a%20b?q=1');
    expect(res.redirect).toHaveBeenCalledWith(308, 'https://bid.advantage.bid/lot/a%20b?q=1');
  });

  test('is case-insensitive on the host', () => {
    const { res } = run('WWW.BID.ADVANTAGE.BID', '/');
    expect(res.redirect).toHaveBeenCalledWith(308, 'https://bid.advantage.bid/');
  });

  test.each([
    ['bid.advantage.bid', '/'],                                   // canonical → never redirect (no loop)
    ['advantage-staging-production.up.railway.app', '/api/health'],
    ['89wikt3w.up.railway.app', '/api/health'],                  // Railway internal
    ['localhost', '/'],
    ['www.advantage.bid', '/'],                                   // the BD marketing site, NOT ours
    ['', '/'],                                                    // missing host
  ])('does NOT redirect %s', (hostname, url) => {
    const { res, next } = run(hostname, url);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  test('destination host is a fixed constant (no Host-header injection)', () => {
    // even a hostile-looking alias value only ever yields the constant canonical host
    expect(CANONICAL_HOST).toBe('bid.advantage.bid');
    const { res, next } = run('evil.com', '//evil.com/steal');
    expect(res.redirect).not.toHaveBeenCalled();  // not an allowlisted alias → pass through
    expect(next).toHaveBeenCalled();
  });
});
