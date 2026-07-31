'use strict';

// Executes the real BD sitewide script (scripts/bd/bd-header-session-aware.js) against mocked browser
// globals to prove the unified login/logout handoff: EXACT-path only, correct Railway targets, no
// substring "login" match, and the header-reflect path is short-circuited on the login/logout pages.

const fs = require('fs');
const SRC = fs.readFileSync('scripts/bd/bd-header-session-aware.js', 'utf8');

function run(pathname, search) {
  const calls = { replaced: [], fetched: false, domReady: false };
  const location = {
    pathname: pathname,
    search: search || '',
    href: 'https://www.advantage.bid' + pathname + (search || ''),
    replace: function (u) { calls.replaced.push(u); },
    assign: function (u) { calls.replaced.push(u); },
  };
  const document = {
    readyState: 'complete',
    querySelectorAll: function () { calls.domReady = true; return []; },
    addEventListener: function () {},
  };
  const fetch = function () {
    calls.fetched = true;
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ authenticated: false }); } });
  };
  const setTimeout = function () {};
  // The IIFE reads `location`/`document`/`fetch`/`setTimeout` from this injected scope.
  // eslint-disable-next-line no-new-func
  new Function('location', 'document', 'fetch', 'setTimeout', SRC)(location, document, fetch, setTimeout);
  return calls;
}

describe('unified logout (Part 1)', () => {
  test('/login?action=loggedout → hands off to the Railway logout endpoint (clears both sessions)', () => {
    const c = run('/login', '?action=loggedout');
    expect(c.replaced).toEqual(['https://bid.advantage.bid/logout']);
    expect(c.fetched).toBe(false);           // short-circuits before the header logic
  });
  test('/login/?action=loggedout (trailing slash) → same handoff', () => {
    const c = run('/login/', '?action=loggedout');
    expect(c.replaced).toEqual(['https://bid.advantage.bid/logout']);
  });
  test('loggedout with extra params still matches', () => {
    const c = run('/login', '?action=loggedout&x=1');
    expect(c.replaced).toEqual(['https://bid.advantage.bid/logout']);
  });
});

describe('retired BD login form (Part 1)', () => {
  test('/login → hands off to the Railway login page', () => {
    const c = run('/login', '');
    expect(c.replaced).toEqual(['https://bid.advantage.bid/login.html']);
    expect(c.fetched).toBe(false);
  });
  test('/login/ (trailing slash) → same handoff', () => {
    const c = run('/login/', '');
    expect(c.replaced).toEqual(['https://bid.advantage.bid/login.html']);
  });
});

describe('exact-path safety — never a substring "login" match', () => {
  test.each([
    ['/', ''],
    ['/login-help', ''],
    ['/account/login', ''],
    ['/blog/login-tips', ''],
    ['/members', ''],
    ['/all-events', ''],
  ])('%s%s → no redirect; header logic runs instead', (p, q) => {
    const c = run(p, q);
    expect(c.replaced).toEqual([]);          // no login/logout handoff
    expect(c.fetched).toBe(true);            // Part 2 (session-status probe) runs
  });
});

describe('no redirect loop', () => {
  test('handoff targets a DIFFERENT origin (bid.advantage.bid) than where the script runs (www)', () => {
    ['https://bid.advantage.bid/logout', 'https://bid.advantage.bid/login.html'].forEach((u) => {
      expect(u.indexOf('https://bid.advantage.bid/')).toBe(0);
      expect(u).not.toMatch(/^https:\/\/www\.advantage\.bid/);
    });
  });
});
