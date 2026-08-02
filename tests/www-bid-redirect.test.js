'use strict';

// Canonical-host redirect: www.bid.advantage.bid must permanently redirect to bid.advantage.bid, and
// nothing else may be affected. The middleware is the very first in server.js so it precedes any auth
// gate/CORS. (Behavioral proof of the exact logic below; source assertion guards its placement.)

const fs = require('fs');

// Replicate the exact predicate/response the middleware uses, to prove the behavior deterministically.
function redirectMiddleware(req, res, next) {
  if (req.hostname === 'www.bid.advantage.bid') {
    return res.redirect(308, 'https://bid.advantage.bid' + req.originalUrl);
  }
  next();
}
function run(hostname, originalUrl) {
  const calls = { redirect: null, next: false };
  const res = { redirect: (code, url) => { calls.redirect = { code, url }; } };
  redirectMiddleware({ hostname, originalUrl }, res, () => { calls.next = true; });
  return calls;
}

describe('www.bid.advantage.bid → bid.advantage.bid', () => {
  test('www.bid host 308-redirects to the canonical host, preserving path + query', () => {
    const r = run('www.bid.advantage.bid', '/app.html?next=%2Fwatchlist#home');
    expect(r.redirect).toEqual({ code: 308, url: 'https://bid.advantage.bid/app.html?next=%2Fwatchlist#home' });
    expect(r.next).toBe(false);
  });
  test('the canonical host passes through untouched (no redirect, no loop)', () => {
    const r = run('bid.advantage.bid', '/');
    expect(r.redirect).toBeNull();
    expect(r.next).toBe(true);
  });
  test('other hosts (BD, apex, railway) are unaffected', () => {
    for (const h of ['www.advantage.bid', 'advantage.bid', 'advantage-auction-platform-production.up.railway.app']) {
      const r = run(h, '/x');
      expect(r.redirect).toBeNull();
      expect(r.next).toBe(true);
    }
  });
});

describe('placement in server.js', () => {
  const src = fs.readFileSync('server.js', 'utf8');
  test('redirect is defined and runs before the CORS block', () => {
    const redirectIdx = src.indexOf("req.hostname === 'www.bid.advantage.bid'");
    const corsIdx = src.indexOf('Access-Control-Allow-Origin');
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(src).toContain("res.redirect(308, 'https://bid.advantage.bid' + req.originalUrl)");
    expect(redirectIdx).toBeLessThan(corsIdx); // first, before auth/CORS
  });
});
