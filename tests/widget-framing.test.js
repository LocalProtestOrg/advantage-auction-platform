'use strict';

/**
 * widgetFraming middleware — /widgets/* is embeddable by the two approved BD parent
 * origins; every other route keeps helmet's X-Frame-Options: SAMEORIGIN.
 */
const widgetFraming = require('../src/middleware/widgetFraming');

// Minimal res double that models the header store the way express/helmet use it:
// helmet has already set X-Frame-Options: SAMEORIGIN before this middleware runs.
function makeRes() {
  const headers = { 'X-Frame-Options': 'SAMEORIGIN' };
  return {
    headers,
    setHeader(k, v) { headers[k] = v; },
    getHeader(k) { return headers[k]; },
    removeHeader(k) { delete headers[k]; },
  };
}
function run(path) {
  const res = makeRes();
  let called = false;
  widgetFraming({ path }, res, () => { called = true; });
  return { res, called };
}

describe('widgetFraming', () => {
  test('widget HTML: X-Frame-Options removed, CSP frame-ancestors allows both BD origins', () => {
    const { res, called } = run('/widgets/marketplace-feed.html');
    expect(called).toBe(true);
    expect(res.getHeader('X-Frame-Options')).toBeUndefined();
    const csp = res.getHeader('Content-Security-Policy');
    expect(csp).toMatch(/frame-ancestors/);
    expect(csp).toContain('https://advantage.bid');
    expect(csp).toContain('https://www.advantage.bid');
  });

  test('widget JS asset is treated the same (whole /widgets/* tree)', () => {
    const { res } = run('/widgets/marketplace-feed.js');
    expect(res.getHeader('X-Frame-Options')).toBeUndefined();
    expect(res.getHeader('Content-Security-Policy')).toBe(widgetFraming.FRAME_ANCESTORS);
  });

  test('widget CSP does NOT contain SAMEORIGIN/DENY and does NOT wildcard frame-ancestors', () => {
    const { res } = run('/widgets/marketplace-feed.html');
    const csp = res.getHeader('Content-Security-Policy');
    expect(csp).not.toMatch(/SAMEORIGIN|DENY/i);
    expect(csp).not.toContain("frame-ancestors *");
    expect(csp).not.toContain("frame-ancestors 'self'");
  });

  test.each([
    '/app.html',                 // member shell
    '/admin/invoices.html',      // admin
    '/auction-view.html',        // auction page
    '/login.html',               // auth
    '/payment.html',             // payment
    '/dashboard.html',           // dashboard
    '/',                         // home
    '/widgets-something.html',   // NOT under /widgets/ — must stay protected
  ])('protected route %s keeps SAMEORIGIN and gets no widget CSP', (path) => {
    const { res } = run(path);
    expect(res.getHeader('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.getHeader('Content-Security-Policy')).toBeUndefined();
  });

  test('always calls next()', () => {
    expect(run('/widgets/x.js').called).toBe(true);
    expect(run('/app.html').called).toBe(true);
  });
});
