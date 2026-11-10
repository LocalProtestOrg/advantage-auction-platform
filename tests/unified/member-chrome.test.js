'use strict';

/**
 * Phase 4D — the persistent unified Marketplace shell across professional pages. The chrome (rail +
 * header + mobile nav) is rendered by ONE shared module (member-chrome.js / AdvChrome) reused by both
 * the SPA (/app.html) and the /org professional pages, so the sidebar never drifts. Pure builder tests
 * + source-level guarantees for the /org integration. (DOM mount/fetch is exercised in the browser.)
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const Chrome = require('../../public/widgets/shared/member-chrome.js');

const PRO_STANDALONE = {
  user: { role: 'buyer', full_name: 'Lewis & Maese Antiques & Auctions' },
  isSeller: false, mode: 'selling', isBdMember: true,
  businessAdminUrl: 'https://www.advantage.bid/business-administration',
  isEventOrganizer: true, inShell: false, activeHref: '/org/events.html',
};

describe('shared chrome renders the unified sidebar for professionals', () => {
  const rail = Chrome.rail(PRO_STANDALONE);

  test('My Events + Create Event + Business Administration all present', () => {
    expect(rail).toContain('My Events');
    expect(rail).toContain('/org/events.html');
    expect(rail).toContain('Create Event');
    expect(rail).toContain('/org/event-new.html');
    expect(rail).toContain('Business Administration');
    expect(rail).toContain('https://www.advantage.bid/business-administration');
  });
  test('buying is one switch away (one account): the Buying / Selling switch is in the rail and the header', () => {
    expect(rail).toContain('Dashboard Home');
    expect(rail).toMatch(/data-mode="buying"[^>]*>Buying</);
    expect(Chrome.header(PRO_STANDALONE)).toMatch(/data-mode="buying"[^>]*>Switch to Buying</);
    const buying = Chrome.rail(Object.assign({}, PRO_STANDALONE, { mode: 'buying' }));
    for (const label of ['Watchlist', 'My Bids', 'Purchases', 'Account']) expect(buying).toContain(label);
  });
  test('on a standalone page, in-shell sections link back to the SPA (/app.html#…)', () => {
    expect(rail).toContain('href="/app.html#home"');
    expect(rail).toContain('href="/app.html#messages"');
    // …while professional workspace items keep their own routes (not rewritten)
    expect(rail).toContain('href="/org/events.html"');
  });
  test('the active workspace is marked current (My Events on /org/events.html)', () => {
    expect(rail).toMatch(/href="\/org\/events\.html" aria-current="page"/);
  });
  test('mobile bottom nav also carries My Events + Business Administration (rail hidden ≤860px)', () => {
    const mobile = Chrome.bottomNav(PRO_STANDALONE);
    expect(mobile).toContain('My Events');
    expect(mobile).toContain('Business Administration');
  });
  test('frame wraps rail + header + main content region + bottom nav', () => {
    const frame = Chrome.frame(PRO_STANDALONE, '<p>content</p>');
    expect(frame).toContain('adv-rail');
    expect(frame).toContain('adv-header');
    expect(frame).toContain('id="adv-main"');
    expect(frame).toContain('<p>content</p>');
    expect(frame).toContain('adv-bottomnav');
  });
});

describe('native buyers never receive professional actions', () => {
  const rail = Chrome.rail({ user: { role: 'buyer' }, isSeller: false, mode: 'buying', inShell: false });
  test('no My Events / Create Event / Business Administration for a plain buyer', () => {
    for (const s of ['My Events', 'Create Event', 'Business Administration']) expect(rail).not.toContain(s);
  });
  test('buying navigation is intact', () => {
    expect(rail).toContain('Watchlist');
  });
});

describe('member-shell delegates its chrome to the shared source (no duplicate sidebar)', () => {
  const shell = read('public', 'widgets', 'shared', 'member-shell.js');
  const app = read('public', 'app.html');
  test('the shell renders via AdvChrome, not its own copy', () => {
    expect(shell).toContain('Chrome.rail');
    expect(shell).toContain('Chrome.header');
    expect(shell).toContain('Chrome.bottomNav');
    expect(shell).toContain('Chrome.frame');
    expect(shell).not.toMatch(/function navItemHtml|function railHtml\(\)\s*\{\s*var items/); // old inline builders gone
  });
  test('app.html loads the shared chrome before the shell', () => {
    expect(app).toContain('/widgets/shared/member-chrome.js');
    expect(app.indexOf('member-chrome.js')).toBeLessThan(app.indexOf('member-shell.js'));
  });
});

describe('/org professional pages mount the shared shell (persistent workspace)', () => {
  const pages = {
    'events': { file: read('public', 'org', 'events.html'), href: '/org/events.html', title: 'My Events' },
    'event-new': { file: read('public', 'org', 'event-new.html'), href: '/org/event-new.html', title: 'Create Event' },
    'event-edit': { file: read('public', 'org', 'event-edit.html'), href: '/org/events.html', title: 'Edit Event' },
  };
  for (const [name, p] of Object.entries(pages)) {
    test(`${name}.html mounts AdvChrome with the correct active workspace + title`, () => {
      expect(p.file).toContain('/widgets/shared/member-chrome.js');
      expect(p.file).toContain('/widgets/shared/member-nav-config.js');
      expect(p.file).toContain('/widgets/shared/advantage-ds.css');
      expect(p.file).toContain("AdvChrome.mountStandalone(");
      expect(p.file).toContain("activeHref: '" + p.href + "'");
      expect(p.file).toContain("title: '" + p.title + "'");
    });
    test(`${name}.html drops the legacy portal header (no duplicate header) + slots content into the shell`, () => {
      expect(p.file).not.toMatch(/ORG\.header\(/);       // legacy standalone header no longer rendered
      expect(p.file).toContain('id="adv-shell-root"');    // shell mounts here
      expect(p.file).toContain('id="org-content"');       // page content moved into the shell main area
    });
    test(`${name}.html keeps its existing org API workflow (functionality preserved)`, () => {
      expect(p.file).toContain('/api/org/');              // still talks to the org API
    });
  }
});

describe('Phase 4E — entitlement-aware Marketplace CTA (three states)', () => {
  const base = { user: { role: 'buyer' }, isSeller: false, mode: 'buying', inShell: true };
  test('STATE 1 — buyer sees "Start selling"', () => {
    const cta = Chrome.modeSwitch(base);
    expect(cta).toContain('Start selling');
    expect(cta).toContain('/become-seller.html');
    expect(cta).not.toContain('Complete Marketplace Seller Setup');
  });
  test('an event organizer without seller setup gets the switch, plus one "Complete Marketplace Seller Setup" link', () => {
    const rail = Chrome.rail(Object.assign({}, base, { isEventOrganizer: true, sellerReady: false }));
    expect(rail).toContain('adv-mode-switch');
    expect(rail).toContain('Complete Marketplace Seller Setup');
    expect(rail).toContain('/become-seller.html');
    expect(rail).not.toContain('Start selling');
  });
  test('every seller (including a Marketplace-ready one) gets the Buying / Selling switch; no onboarding link', () => {
    for (const extra of [{ isSeller: true, sellerReady: true, user: { role: 'seller' } }, { isEventOrganizer: true, sellerReady: true }]) {
      const ctx = Object.assign({}, base, extra);
      const sw = Chrome.modeSwitch(ctx);
      expect(sw).toContain('adv-mode-switch');
      expect(sw).toMatch(/data-mode="selling"[^>]*>Selling</);
      expect(sw).toMatch(/adv-mode-opt on" aria-current="true">Buying</);
      expect(Chrome.rail(ctx)).not.toContain('Complete Marketplace Seller Setup');
    }
  });
});

describe('the Buying / Selling switch decides the menu (owner 2026-11-10)', () => {
  const Nav = require('../../public/widgets/shared/member-nav-config.js');
  const ids = (ctx) => Nav.visibleNavFor(ctx).map((i) => i.id);
  test('Business Administration is pinned to the TOP in every experience', () => {
    const first = (ctx) => (Nav.visibleNavFor(ctx)[0] || {}).id;
    expect(first({ role: 'buyer', mode: 'buying', isBdMember: true, businessAdminUrl: 'x' })).toBe('bizadmin');
    expect(first({ role: 'buyer', mode: 'selling', isEventOrganizer: true, isBdMember: true, businessAdminUrl: 'x' })).toBe('bizadmin');
    expect(first({ role: 'admin', mode: 'admin', isBdMember: true, businessAdminUrl: 'x' })).toBe('bizadmin');
    expect(Nav.visibleNavFor({ role: 'buyer', mode: 'buying', isBdMember: true, businessAdminUrl: 'https://www.advantage.bid/account' })[0].href)
      .toBe('https://www.advantage.bid/account');
    expect(ids({ role: 'buyer', mode: 'buying' })).not.toContain('bizadmin');
  });
  test('Buying is the buyer list for everyone, professionals included (no seller tools)', () => {
    const pro = ids({ role: 'seller', mode: 'buying', isSeller: true, sellerReady: true, storefrontEligible: true, isEventOrganizer: true });
    expect(pro).toEqual(['home', 'watchlist', 'auctions', 'purchases', 'messages', 'account']);
  });
  test('Selling for a Professional Seller: Storefront first, then Online Auctions, then the general items', () => {
    const secs = Nav.visibleSectionsFor({ role: 'seller', mode: 'selling', isSeller: true, sellerReady: true, storefrontEligible: true });
    expect(secs.map((s) => s.heading)).toEqual([null, 'Storefront', 'Online Auctions', null]);
    expect(secs[1].items.map((i) => i.label)).toEqual(['Add Item', 'Manage Inventory', 'My Storefront', 'Orders', 'Website Widgets', 'Payouts']);
    expect(secs[2].items.map((i) => i.label)).toEqual(['Create Online Auction', 'Manage Online Auctions', 'Sale Stats', 'Auction Payments']);
    expect(secs[3].items.map((i) => i.label)).toEqual(['Seller How To Center', 'Messages', 'Seller Settings']);
    expect(Nav.byId('addItem', { role: 'seller', mode: 'selling', isSeller: true, sellerReady: true, storefrontEligible: true }).href).toBe('/seller-storefront.html?tab=market');
  });
  test('Selling for an Individual Seller: auctions and a way to open a Professional Storefront; no storefront tools', () => {
    const v = ids({ role: 'seller', mode: 'selling', isSeller: true, sellerReady: true, storefrontEligible: false });
    expect(v).toEqual(['home', 'createAuction', 'sell', 'analytics', 'payments', 'goPro', 'messages', 'account']);
    expect(Nav.byId('goPro', { role: 'seller', mode: 'selling', isSeller: true }).href).toBe('/become-professional-seller.html');
  });
  test('Selling for an event organizer: My Events, Create Event and Import My Events, distinct from auctions', () => {
    const secs = Nav.visibleSectionsFor({ role: 'buyer', mode: 'selling', isEventOrganizer: true, isBdMember: true, businessAdminUrl: 'x' });
    expect(secs[0].items.map((i) => i.id)).toEqual(['bizadmin']);
    expect(secs.find((s) => s.heading === 'Events').items.map((i) => i.id)).toEqual(['events', 'createEvent', 'importEvents']);
    expect(ids({ role: 'buyer', mode: 'selling', isEventOrganizer: true })).not.toContain('createAuction');
    expect(Nav.availableModes({ role: 'buyer', isEventOrganizer: true })).toEqual(['buying', 'selling']);
  });
  test('a pure buyer has one experience and never sees seller tools', () => {
    expect(Nav.availableModes({ role: 'buyer' })).toEqual(['buying']);
    expect(ids({ role: 'buyer', mode: 'selling' })).toEqual(['home', 'watchlist', 'auctions', 'purchases', 'messages', 'account']);
  });
});

describe('Phase 4E — mobile "More" menu keeps everything reachable for professionals', () => {
  const PRO = { user: { role: 'seller' }, isSeller: true, mode: 'selling', storefrontEligible: true, isEventOrganizer: true, isBdMember: true, businessAdminUrl: 'https://www.advantage.bid/account' };
  test('professional bottom nav shows a compact More button + a sheet with the overflow (incl. Business Administration)', () => {
    const mobile = Chrome.bottomNav(PRO);
    expect(mobile).toContain('id="adv-more-btn"');
    expect(mobile).toContain('adv-moresheet');
    expect(mobile).toContain('Business Administration'); // reachable via the More sheet
  });
  test('a plain buyer keeps the flat bottom nav (no More)', () => {
    const mobile = Chrome.bottomNav({ user: { role: 'buyer' }, isSeller: false, mode: 'buying' });
    expect(mobile).not.toContain('id="adv-more-btn"');
  });
});

describe('Phase 4E — seller_ready flag + Business Administration → /account', () => {
  const auth = read('src', 'routes', 'auth.js');
  const cfg = read('src', 'lib', 'bridgeConfig.js');
  test('/me derives seller_ready from a seller_profile + a satisfied agreement gate', () => {
    expect(auth).toMatch(/seller_ready/);
    expect(auth).toMatch(/dashboardAccess\(sp\.id\)\)\.access === true/);
  });
  test('Business Administration defaults to BD /account (not the marketing landing, not the bridge)', () => {
    expect(cfg).toMatch(/www\.advantage\.bid\/account/);
    expect(cfg).not.toMatch(/\/business-administration'/);
  });
  test('member-shell wires seller_ready into the chrome context', () => {
    const shell = read('public', 'widgets', 'shared', 'member-shell.js');
    expect(shell).toContain('me.body.data.seller_ready === true');
    expect(shell).toMatch(/sellerReady:\s*state\.sellerReady/);
  });
});

describe('safety: no redirect loops, unauthenticated deep-links return to intent', () => {
  const chrome = read('public', 'widgets', 'shared', 'member-chrome.js');
  test('unauthenticated standalone visit redirects to login preserving the return path', () => {
    expect(chrome).toMatch(/login\.html\?next=' \+ encodeURIComponent\(location\.pathname \+ location\.search\)/);
  });
  test('Business Administration target is a BD page, never the app bridge (no loop)', () => {
    // The URL is server-provided; the chrome only renders it. Guard that the chrome never hardcodes a bridge loop.
    expect(chrome).not.toMatch(/enter-auctions/);
  });
});
