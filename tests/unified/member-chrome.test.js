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
  isSeller: false, mode: 'buying', isBdMember: true,
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
  test('buying navigation remains visible (one account — never removed for professionals)', () => {
    for (const label of ['Dashboard Home', 'Watchlist', 'My Bids', 'Purchases', 'Account']) expect(rail).toContain(label);
  });
  test('on a standalone page, in-shell sections link back to the SPA (/app.html#…)', () => {
    expect(rail).toContain('href="/app.html#home"');
    expect(rail).toContain('href="/app.html#watchlist"');
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
  test('STATE 2 — professional without complete setup sees "Complete Marketplace Seller Setup"', () => {
    const cta = Chrome.modeSwitch(Object.assign({ isEventOrganizer: true, sellerReady: false }, base));
    expect(cta).toContain('Complete Marketplace Seller Setup');
    expect(cta).toContain('/become-seller.html');
    expect(cta).not.toContain('Start selling');
  });
  test('STATE 3 — Marketplace-ready seller has no onboarding CTA (Create Online Auction is in the nav)', () => {
    const cta = Chrome.modeSwitch(Object.assign({ isEventOrganizer: true, sellerReady: true }, base));
    expect(cta).toBe('');
  });
});

describe('Phase 4E — professional-first navigation ordering', () => {
  const Nav = require('../../public/widgets/shared/member-nav-config.js');
  test('Business Administration is pinned to the TOP (first nav item); professional tools still precede buying', () => {
    const v = Nav.visibleNavFor({ role: 'buyer', mode: 'buying', isEventOrganizer: true, isBdMember: true, businessAdminUrl: 'x' });
    const order = v.map((i) => i.id);
    expect(order[0]).toBe('bizadmin');                                          // gateway back to BD — the very first item
    expect(order.indexOf('bizadmin')).toBeLessThan(order.indexOf('home'));      // above Dashboard Home
    expect(order.indexOf('events')).toBeLessThan(order.indexOf('watchlist'));   // My Events before Buying
    expect(order.indexOf('createEvent')).toBeLessThan(order.indexOf('watchlist'));
    for (const b of ['watchlist', 'auctions', 'purchases', 'account']) expect(order).toContain(b); // buying preserved
  });
  test('nav is grouped into labelled sections; Business Administration is its own TOP section', () => {
    const secs = Nav.visibleSectionsFor({ role: 'buyer', mode: 'buying', isEventOrganizer: true, isBdMember: true, businessAdminUrl: 'x' });
    expect(secs[0].items.map((i) => i.id)).toEqual(['bizadmin']);  // Business Administration first, no heading
    expect(secs[0].heading).toBeNull();
    expect(secs[1].items.map((i) => i.id)).toEqual(['home']);      // Dashboard Home next
    const pro = secs.find((s) => s.heading === 'Professional Marketplace');
    const buying = secs.find((s) => s.heading === 'Buying');
    expect(pro.items.map((i) => i.id)).toEqual(['events', 'createEvent']); // bizadmin no longer inside the pro group
    expect(buying.items.map((i) => i.id)).toEqual(['watchlist', 'auctions', 'purchases']);
  });
  test('the rail renders the "Professional Marketplace" section heading', () => {
    const rail = Chrome.rail({ user: { role: 'buyer' }, isSeller: false, mode: 'buying', isEventOrganizer: true, isBdMember: true, businessAdminUrl: 'https://www.advantage.bid/account' });
    expect(rail).toContain('adv-nav-section');
    expect(rail).toContain('Professional Marketplace');
    expect(rail).toContain('Buying');
  });
  test('a future seller tool inserts into the pro section via the registry (no restructuring needed)', () => {
    // The registry drives professionalMarketplaceItems; adding a row appears in this list. Business
    // Administration is no longer here — it is pinned to the top section (see visibleSectionsFor).
    const ready = Nav.visibleSectionsFor({ role: 'buyer', mode: 'buying', isEventOrganizer: true, sellerReady: true, isBdMember: true, businessAdminUrl: 'x' });
    const pro = ready.find((s) => s.heading === 'Professional Marketplace');
    expect(pro.items.map((i) => i.id)).toEqual(['events', 'createEvent', 'createAuction', 'sell']);
  });
  test('Business Administration is the FIRST item across experiences (buyer, professional, admin)', () => {
    const first = (ctx) => (Nav.visibleNavFor(ctx)[0] || {}).id;
    // non-professional BD buyer
    expect(first({ role: 'buyer', mode: 'buying', isBdMember: true, businessAdminUrl: 'x' })).toBe('bizadmin');
    // professional (event organizer) BD member
    expect(first({ role: 'buyer', mode: 'buying', isEventOrganizer: true, isBdMember: true, businessAdminUrl: 'x' })).toBe('bizadmin');
    // admin who is a BD member
    expect(first({ role: 'admin', mode: 'admin', isBdMember: true, businessAdminUrl: 'x' })).toBe('bizadmin');
    // destination unchanged (server-authoritative href)
    expect(Nav.visibleNavFor({ role: 'buyer', mode: 'buying', isBdMember: true, businessAdminUrl: 'https://www.advantage.bid/account' })[0].href)
      .toBe('https://www.advantage.bid/account');
    // no BD context → no bizadmin item at all
    expect(Nav.visibleNavFor({ role: 'buyer', mode: 'buying' }).some((i) => i.id === 'bizadmin')).toBe(false);
  });
  test('Create/Manage Online Auction appear ONLY when seller_ready (State 3) and stay distinct from events', () => {
    const notReady = Nav.visibleNavFor({ role: 'buyer', mode: 'buying', isEventOrganizer: true, sellerReady: false });
    expect(notReady.map((i) => i.id)).not.toContain('createAuction');
    const ready = Nav.visibleNavFor({ role: 'buyer', mode: 'buying', isEventOrganizer: true, sellerReady: true });
    const ca = ready.find((i) => i.id === 'createAuction');
    const ma = ready.find((i) => i.id === 'sell');
    expect(ca.label).toBe('Create Online Auction');
    expect(ca.href).toBe('/seller-create.html');
    expect(ma.label).toBe('Manage Online Auctions');
    // Event vs Auction stay separate workflows
    expect(ready.find((i) => i.id === 'createEvent').label).toBe('Create Event');
    expect(ca.href).not.toBe(ready.find((i) => i.id === 'createEvent').href);
  });
  test('a native seller who completed setup also gets the professional-first nav (capability-aware)', () => {
    const v = Nav.visibleNavFor({ role: 'seller', mode: 'buying', isSeller: true, sellerReady: true });
    const order = v.map((i) => i.id);
    expect(order).toContain('createAuction');
    expect(order).toContain('sell');
    expect(order).toContain('watchlist'); // buying preserved
  });
});

describe('Phase 4E — mobile "More" menu keeps everything reachable for professionals', () => {
  const PRO = { user: { role: 'buyer' }, isSeller: false, mode: 'buying', isEventOrganizer: true, isBdMember: true, businessAdminUrl: 'https://www.advantage.bid/account' };
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
