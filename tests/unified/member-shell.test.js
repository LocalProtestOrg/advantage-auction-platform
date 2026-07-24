'use strict';

/**
 * Phase 2 unified member shell — role-aware navigation logic (pure, isomorphic module) plus
 * source-level guarantees about the parallel /app.html route. No DOM/jsdom required.
 */

const fs = require('fs');
const path = require('path');
const Nav = require('../../public/widgets/shared/member-nav-config.js');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const ids = (arr) => arr.map((i) => i.id);

describe('navigation visibility by role', () => {
  test('logged-out (no/invalid role) → no nav', () => {
    expect(Nav.visibleNavFor({ role: null })).toEqual([]);
    expect(Nav.visibleNavFor({ role: 'nonsense' })).toEqual([]);
    expect(Nav.visibleNavFor({})).toEqual([]);
  });

  test('buyer → all buyer destinations, Analytics hidden', () => {
    const v = ids(Nav.visibleNavFor({ role: 'buyer', isSeller: false }));
    expect(v).toEqual(['home', 'auctions', 'watchlist', 'purchases', 'sellers', 'sell', 'messages', 'account']);
    expect(v).not.toContain('analytics');
    expect(v).toContain('sell'); // Sell is visible to non-sellers (education/enroll surface)
  });

  test('buyer WITH a seller profile → buyer set + Analytics', () => {
    const v = ids(Nav.visibleNavFor({ role: 'buyer', isSeller: true }));
    expect(v).toContain('analytics');
    expect(v.length).toBe(9);
  });

  test('seller → full set (9)', () => {
    expect(ids(Nav.visibleNavFor({ role: 'seller' }))).toHaveLength(9);
  });

  test('admin → full set (9), superset', () => {
    const v = ids(Nav.visibleNavFor({ role: 'admin' }));
    expect(v).toHaveLength(9);
    expect(v).toEqual(expect.arrayContaining(['analytics', 'account', 'home']));
  });

  test('mobile primary nav = 5 highest-frequency items', () => {
    const m = ids(Nav.primaryMobileNav({ role: 'buyer' }));
    expect(m).toEqual(['home', 'auctions', 'watchlist', 'purchases', 'account']);
  });

  test('the 9 approved destinations exist with the right emojis', () => {
    const wanted = { home: '🏠', auctions: '🔨', watchlist: '❤️', purchases: '📦', sellers: '🏪',
      sell: '📈', analytics: '📊', messages: '💬', account: '⚙️' };
    for (const id of Object.keys(wanted)) expect(Nav.byId(id).emoji).toBe(wanted[id]);
    expect(Nav.NAV).toHaveLength(9);
  });

  test('normalizeRole only trusts buyer/seller/admin', () => {
    expect(Nav.normalizeRole('BUYER')).toBe('buyer');
    expect(Nav.normalizeRole('owner')).toBeNull();
    expect(Nav.normalizeRole(undefined)).toBeNull();
  });
});

describe('parallel /app.html route is additive + wired to shared assets', () => {
  const html = read('public', 'app.html');
  test('loads the design system, nav config, shell, and shared auth-refresh', () => {
    expect(html).toContain('/widgets/shared/advantage-ds.css');
    expect(html).toContain('/widgets/shared/member-nav-config.js');
    expect(html).toContain('/widgets/shared/member-shell.js');
    expect(html).toContain('/widgets/shared/auth-refresh.js');
    expect(html).toContain('id="adv-shell-root"');
    expect(html).toContain('noindex');
  });
});

describe('member shell guarantees', () => {
  const src = read('public', 'widgets', 'shared', 'member-shell.js');
  test('handles all required states', () => {
    for (const s of ['renderLoading', 'renderLoggedOut', 'renderUnauthorized', 'renderError'])
      expect(src).toContain(s);
  });
  test('wires ONLY real identity/role endpoints (auth/me + sellers/me)', () => {
    expect(src).toContain("/api/auth/me");
    expect(src).toContain("/api/sellers/me");
    expect(src).toContain('Bearer');
  });
  test('logout clears the token and returns to native login', () => {
    expect(src).toMatch(/removeItem\(['"]token['"]\)/);
    expect(src).toContain('/login.html');
  });
  test('Messages is framed as Updates & Notifications, not two-way messaging', () => {
    expect(src).toContain('Updates &amp; Notifications');
    expect(src.toLowerCase()).toContain('conversations — coming later');
    expect(src.toLowerCase()).toContain('not two-way messaging');
  });
  test('does not touch or depend on the existing buyer-nav component', () => {
    expect(src).not.toContain('buyer-nav');
  });
});

describe('buyer Home wires live data via existing APIs (Phase 3)', () => {
  const src = read('public', 'widgets', 'shared', 'member-shell.js');
  const html = read('public', 'app.html');
  test('page loads the shared bid kit before the shell', () => {
    expect(html).toContain('/widgets/shared/bid-utils.js');
    expect(html).toContain('/widgets/shared/bid-status.js');
  });
  test('home fetches watchlist, my-bids, combined invoices, following', () => {
    for (const p of ['/api/watchlist', '/api/lots/my-bids', '/api/invoices/mine/combined', '/api/sellers/following'])
      expect(src).toContain(p);
  });
  test('reuses BidStatus.deriveBidderStatus rather than reinventing bid logic', () => {
    expect(src).toContain('BidStatus.deriveBidderStatus');
  });
  test('payment-due detection matches the invoice payable statuses', () => {
    for (const s of ['issued', 'payment_required', 'payment_failed']) expect(src).toContain(s);
  });
  test('attention CTAs deep-link to the working pay/lot/browse pages', () => {
    expect(src).toContain('/invoices.html');
    expect(src).toContain('/lot.html?id=');
    expect(src).toContain('/auction.html');
  });
});
