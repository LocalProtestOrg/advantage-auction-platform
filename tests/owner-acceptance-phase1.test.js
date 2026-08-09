'use strict';

/**
 * Owner Acceptance Phase 1 — three launch-readiness fixes:
 *  1. Real-time bidding: the client must reconcile with the server's authoritative closes_at/state and
 *     never declare a lot ended from a stale local countdown; missed events recover on reconnect/visibility.
 *     Server authority + anti-snipe are unchanged (guarded here).
 *  2. Auction-terms return flow: the terms link carries the originating lot, and the return is validated
 *     to a SAFE same-origin internal path only (no open redirect).
 *  3. become-seller button contrast: anchor CTAs render white-on-blue (not blue-on-blue).
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const lot = read('public/lot.html');
const buyerTerms = read('public/buyer-terms.html');
const onboardingCss = read('public/widgets/shared/onboarding.css');
const lotsRoute = read('src/routes/lots.js');
const bidService = read('src/services/bidService.js');

describe('Task 1 — real-time bidding: server-authoritative client reconciliation', () => {
  test('the local countdown never declares "Ended" on its own — it reconciles with the server', () => {
    // The old behavior (val.textContent = 'Ended' at remaining<=0) is gone; the timer now re-fetches.
    const start = lot.indexOf('function tick()');
    const tickBody = lot.slice(start, start + 1400);
    expect(tickBody).toMatch(/if \(remaining <= 0\)/);
    expect(tickBody).toMatch(/refreshLotNow\(\);/);            // reconcile with authoritative state
    expect(tickBody).not.toMatch(/val\.textContent = 'Ended'/); // no local-only "Ended" verdict
    expect(tickBody).toMatch(/'Closing…'/);                    // neutral pending state while reconciling
  });

  test('missed events recover on tab visibility/focus and on socket (re)connect', () => {
    expect(lot).toMatch(/visibilitychange['"]?, \(\) => \{ if \(!document\.hidden\) reconcile\(\); \}/);
    expect(lot).toMatch(/window\.addEventListener\('focus', reconcile\)/);
    expect(lot).toMatch(/socket\.on\('connect', \(\) => \{ joinIfReady\(\); reconcile\(\); \}\)/);
    // reconcile is a guarded refreshLotNow (no-op for guests)
    expect(lot).toMatch(/const reconcile = \(\) => \{ if \(token\) refreshLotNow\(\); \}/);
  });

  test('SERVER remains authoritative: the bid endpoint rejects on the DB closes_at, not the browser', () => {
    // A stale browser showing zero cannot make the server reject a timely bid — the server checks the
    // persisted (possibly-extended) closes_at itself.
    expect(lotsRoute).toMatch(/if \(lot\.closes_at && new Date\(\) > new Date\(lot\.closes_at\)\)/);
    expect(lotsRoute).toMatch(/Lot has closed and is no longer accepting bids/);
  });

  test('anti-snipe extension is unchanged (+2 minutes, persisted) — not weakened', () => {
    expect(bidService).toMatch(/closes_at\s*\+ interval '2 minutes'/);
    expect(bidService).toMatch(/extension_count = extension_count \+ 1/);
  });
});

describe('Task 2 — auction-terms return flow (safe internal return only)', () => {
  test('the bid-gate terms link carries the originating lot as ?next=', () => {
    expect(lot).toMatch(/\/buyer-terms\.html\?next=' \+ encodeURIComponent\(location\.pathname \+ location\.search\)/);
  });
  test('buyer-terms validates the return to a SAFE same-origin internal path (no open redirect)', () => {
    expect(buyerTerms).toMatch(/function safeInternalNext/);
    expect(buyerTerms).toMatch(/const NEXT = safeInternalNext\(/);
    // NEXT is only used AFTER validation (redirect + link)
    expect(buyerTerms).toMatch(/location\.href = NEXT/);
  });

  // Pure open-redirect logic test — mirrors safeInternalNext() in buyer-terms.html.
  function safeInternalNext(raw, origin = 'https://bid.advantage.bid') {
    if (!raw) return '';
    try {
      if (!/^\/(?!\/)[^\s]*$/.test(raw)) return '';
      const u = new URL(raw, origin);
      return u.origin === origin ? (u.pathname + u.search + u.hash) : '';
    } catch (e) { return ''; }
  }
  test('the validation allows internal lot paths and rejects open-redirect vectors', () => {
    expect(safeInternalNext('/lot.html?lotId=abc')).toBe('/lot.html?lotId=abc');       // allowed
    expect(safeInternalNext('/auction-view.html?auctionId=x')).toBe('/auction-view.html?auctionId=x');
    expect(safeInternalNext('//evil.com')).toBe('');                                   // protocol-relative
    expect(safeInternalNext('https://evil.com')).toBe('');                             // absolute cross-origin
    expect(safeInternalNext('http://evil.com/lot.html')).toBe('');
    expect(safeInternalNext('javascript:alert(1)')).toBe('');                          // scheme
    expect(safeInternalNext('')).toBe('');
    expect(safeInternalNext(null)).toBe('');
  });
});

describe('Task 3 — become-seller button contrast (anchor CTAs readable)', () => {
  test('anchor .ob-cta gets white text in every state (overrides the .ob-body a blue link color)', () => {
    expect(onboardingCss).toMatch(/\.ob-body a\.ob-cta,\.ob-body a\.ob-cta:hover,\.ob-body a\.ob-cta:focus\{color:#fff;text-decoration:none\}/);
    // the CTA background is the accent — so this yields white-on-blue, not blue-on-blue
    expect(onboardingCss).toMatch(/\.ob-cta\{[^}]*background:var\(--ob-accent\)[^}]*color:#fff/);
  });
  test('secondary CTA (.ob-cta-2) is intentionally blue-on-transparent and untouched', () => {
    expect(onboardingCss).toMatch(/\.ob-cta-2\{[^}]*background:transparent[^}]*color:var\(--ob-accent\)/);
  });
});
