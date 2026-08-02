'use strict';

// Canonical-host redirect: www.bid.advantage.bid must permanently redirect to bid.advantage.bid, and
// nothing else may be affected. Tests the real middleware module (src/middleware/canonicalHost.js) and
// verifies server.js mounts it before the CORS block.

const fs = require('fs');
const canonicalHost = require('../src/middleware/canonicalHost');

function run(hostname, originalUrl) {
  const calls = { redirect: null, next: false };
  const res = { redirect: (code, url) => { calls.redirect = { code, url }; } };
  canonicalHost({ hostname, originalUrl }, res, () => { calls.next = true; });
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

describe('server.js mounts the redirect before CORS', () => {
  const src = fs.readFileSync('server.js', 'utf8');
  test('canonicalHost is mounted and runs before the CORS block', () => {
    const mountIdx = src.indexOf("require('./src/middleware/canonicalHost')");
    const corsIdx = src.indexOf('Access-Control-Allow-Origin');
    expect(mountIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeLessThan(corsIdx);
  });
});
