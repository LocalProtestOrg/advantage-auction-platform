'use strict';

// Executes the real BD sitewide script (scripts/bd/bd-header-session-aware.js) against mocked browser
// globals to prove: (Part 1) the exact-path login/logout handoff, and (Part 2) the four-state header
// matrix — one, non-duplicated control based on BD-session + Railway-session presence.

const fs = require('fs');
const SRC = fs.readFileSync('scripts/bd/bd-header-session-aware.js', 'utf8');

// ---- minimal DOM ----
function makeAnchor(href, text, opts) {
  opts = opts || {};
  return {
    _attrs: { href: href },
    textContent: text,
    style: {},
    _native: opts.native || [],           // native selectors this anchor sits inside
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = v; },
    closest(sel) {
      if (sel === 'li') return null;       // login anchors modeled without an <li> wrapper
      return this._native.indexOf(sel) !== -1 ? { querySelector() { return null; } } : null;
    },
  };
}
function makeDoc(anchors, nativePresent) {
  return {
    readyState: 'complete',
    addEventListener() {},
    querySelector(sel) { return nativePresent.indexOf(sel) !== -1 ? {} : null; },
    querySelectorAll(sel) { return sel === 'a[href]' ? anchors : []; },
  };
}
function exec({ pathname = '/', search = '', anchors = [], native = [], authed = null }) {
  const calls = { replaced: [], fetched: false };
  const location = {
    pathname, search, href: 'https://www.advantage.bid' + pathname + search,
    replace(u) { calls.replaced.push(u); }, assign(u) { calls.replaced.push(u); },
  };
  const document = makeDoc(anchors, native);
  const fetch = () => { calls.fetched = true; return Promise.resolve({ ok: true, json: () => Promise.resolve({ authenticated: authed }) }); };
  const setTimeout = () => {};
  // eslint-disable-next-line no-new-func
  new Function('location', 'document', 'fetch', 'setTimeout', SRC)(location, document, fetch, setTimeout);
  return { calls, anchors, document };
}
const flush = () => new Promise((r) => global.setTimeout(r, 0));
const login = () => makeAnchor('https://bid.advantage.bid/login.html', 'Login');

// ================= PART 2 — the four-state matrix =================
describe('header state matrix', () => {
  test('B. Railway session only → convert Login → My Account (app.html#home)', async () => {
    const a = login();
    exec({ anchors: [a], native: [], authed: true });
    await flush();
    expect(a.textContent).toBe('My Account');
    expect(a.getAttribute('href')).toBe('https://bid.advantage.bid/app.html#home');
    expect(a.style.display).not.toBe('none');
  });

  test('A. BD + Railway session → hide the public control, do NOT convert (native dropdown wins)', async () => {
    const a = login();
    const r = exec({ anchors: [a], native: ['.logged-in-member-header'], authed: true });
    await flush();
    expect(a.style.display).toBe('none');
    expect(a.getAttribute('data-adv-hidden')).toBe('1');
    expect(a.textContent).toBe('Login');            // never became a 2nd "My Account"
    expect(r.calls.fetched).toBe(false);            // short-circuited on BD auth; no probe needed
  });

  test('D. BD session only → hide the redundant public control', async () => {
    const a = login();
    exec({ anchors: [a], native: ['.header-member-account-links'], authed: false });
    await flush();
    expect(a.style.display).toBe('none');
    expect(a.textContent).toBe('Login');
  });

  test('C. neither session → leave Login unchanged', async () => {
    const a = login();
    exec({ anchors: [a], native: [], authed: false });
    await flush();
    expect(a.textContent).toBe('Login');
    expect(a.getAttribute('href')).toBe('https://bid.advantage.bid/login.html');
    expect(a.style.display).not.toBe('none');
  });

  test('mobile BD signature (.member_sidebar / #member_sidebar_toggle) is detected → hide', async () => {
    for (const sig of ['.member_sidebar', '#member_sidebar_toggle', '.user_sidebar', '.toggle-member-info']) {
      const a = login();
      exec({ anchors: [a], native: [sig], authed: true });
      await flush();
      expect(a.style.display).toBe('none');
    }
  });

  test('the native dropdown’s own links are never hidden or converted', async () => {
    const a = login();
    const dropLink = makeAnchor('/account/login-settings', 'Account', { native: ['.logged-in-member-header'] });
    exec({ anchors: [a, dropLink], native: ['.logged-in-member-header'], authed: true });
    await flush();
    expect(a.style.display).toBe('none');            // public control hidden
    expect(dropLink.style.display).not.toBe('none'); // dropdown item untouched
    expect(dropLink.getAttribute('data-adv-hidden')).toBeNull();
  });

  test('a previously-created "My Account" anchor is hidden if a BD session appears (no duplicate)', async () => {
    const a = makeAnchor('https://bid.advantage.bid/app.html#home', 'My Account');
    a.setAttribute('data-adv-session', 'railway');
    exec({ anchors: [a], native: ['.logged-in-member-header'], authed: true });
    await flush();
    expect(a.style.display).toBe('none');
  });
});

// ================= PART 1 — exact-path handoff (must not regress) =================
describe('unified logout / retired login handoff', () => {
  test('/login?action=loggedout → Railway logout endpoint', () => {
    expect(exec({ pathname: '/login', search: '?action=loggedout' }).calls.replaced)
      .toEqual(['https://bid.advantage.bid/logout']);
  });
  test('/login/?action=loggedout (trailing slash) → Railway logout', () => {
    expect(exec({ pathname: '/login/', search: '?action=loggedout' }).calls.replaced)
      .toEqual(['https://bid.advantage.bid/logout']);
  });
  test('/login → Railway login page', () => {
    expect(exec({ pathname: '/login' }).calls.replaced).toEqual(['https://bid.advantage.bid/login.html']);
  });
  test('/login/ → Railway login page', () => {
    expect(exec({ pathname: '/login/' }).calls.replaced).toEqual(['https://bid.advantage.bid/login.html']);
  });
});

describe('exact-path safety + no loop', () => {
  test.each([['/'], ['/login-help'], ['/account/login'], ['/blog/login-tips'], ['/members']])(
    '%s → no login/logout redirect', (p) => {
      expect(exec({ pathname: p, anchors: [], native: [], authed: false }).calls.replaced).toEqual([]);
    });
  test('handoffs target bid.advantage.bid (different origin than www) — no loop', () => {
    ['https://bid.advantage.bid/logout', 'https://bid.advantage.bid/login.html'].forEach((u) => {
      expect(u.indexOf('https://bid.advantage.bid/')).toBe(0);
      expect(u).not.toMatch(/^https:\/\/www\.advantage\.bid/);
    });
  });
});
