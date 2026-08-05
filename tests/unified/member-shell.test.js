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

describe('one account, three experiences — mode-aware navigation', () => {
  const ids = (arr) => arr.map((i) => i.id);

  test('logged-out (no/invalid role) → no nav, no modes', () => {
    expect(Nav.visibleNavFor({ role: null })).toEqual([]);
    expect(Nav.availableModes({ role: 'nonsense' })).toEqual([]);
  });

  test('BUYING experience — a clean marketplace nav (no seller ops)', () => {
    const v = ids(Nav.visibleNavFor({ role: 'buyer', mode: 'buying' }));
    expect(v).toEqual(['home', 'watchlist', 'auctions', 'purchases', 'messages', 'account']);
    for (const sellerOnly of ['sell', 'analytics', 'create', 'payments']) expect(v).not.toContain(sellerOnly);
  });

  test('SELLING experience — an operational workspace with plain-language labels', () => {
    const v = Nav.visibleNavFor({ role: 'seller', mode: 'selling' });
    expect(ids(v)).toEqual(['home', 'sell', 'create', 'analytics', 'payments', 'messages', 'account']);
    expect(v.find((i) => i.id === 'sell').label).toBe('My Auctions');       // not "Workspace"
    expect(v.find((i) => i.id === 'analytics').label).toBe('Sale Stats');   // not "Analytics"
    expect(v.find((i) => i.id === 'payments').label).toBe('Payments');      // not "Settlement"
    expect(v.find((i) => i.id === 'create').external).toBe(true);
  });

  test('ADMIN experience — a dedicated operational nav (not buyer/seller-shaped)', () => {
    const v = ids(Nav.visibleNavFor({ role: 'admin', mode: 'admin' }));
    expect(v).toEqual(['home', 'moderate', 'invoices', 'members', 'messages', 'account']);
  });

  test('progressive disclosure — a pure buyer has ONE experience (never a switch)', () => {
    expect(Nav.availableModes({ role: 'buyer', isSeller: false })).toEqual(['buying']);
    expect(Nav.defaultMode({ role: 'buyer' })).toBe('buying');
  });

  test('buyer+seller can switch Buying⇄Selling, buyer-first by default', () => {
    expect(Nav.availableModes({ role: 'buyer', isSeller: true })).toEqual(['buying', 'selling']);
    expect(Nav.defaultMode({ role: 'buyer', isSeller: true })).toBe('buying');
  });

  test('admin defaults to Admin with view-as for testing', () => {
    expect(Nav.defaultMode({ role: 'admin' })).toBe('admin');
    expect(Nav.availableModes({ role: 'admin' })).toEqual(['admin', 'selling', 'buying']);
  });

  test('resolveMode never grants an experience the user is not allowed', () => {
    expect(Nav.resolveMode({ role: 'buyer' }, 'selling')).toBe('buying'); // buyer cannot enter selling
    expect(Nav.resolveMode({ role: 'buyer', isSeller: true }, 'selling')).toBe('selling');
    expect(Nav.resolveMode({ role: 'admin' }, 'buying')).toBe('buying');
  });

  test('mobile primary nav is the highest-frequency subset of the active experience', () => {
    expect(ids(Nav.primaryMobileNav({ role: 'buyer', mode: 'buying' }))).toEqual(['home', 'watchlist', 'auctions', 'purchases', 'account']);
  });

  test('normalizeRole only trusts buyer/seller/admin', () => {
    expect(Nav.normalizeRole('BUYER')).toBe('buyer');
    expect(Nav.normalizeRole('owner')).toBeNull();
    expect(Nav.normalizeRole(undefined)).toBeNull();
  });
});

describe('unified BD ↔ Marketplace navigation — "Business Administration" return link', () => {
  const BD = { isBdMember: true, businessAdminUrl: 'https://www.advantage.bid/account' };

  test('BD members get a "Business Administration" item appended to every experience', () => {
    for (const ctx of [
      Object.assign({ role: 'buyer', mode: 'buying' }, BD),
      Object.assign({ role: 'seller', mode: 'selling' }, BD),
      Object.assign({ role: 'admin', mode: 'admin' }, BD),
    ]) {
      const biz = Nav.visibleNavFor(ctx).find((i) => i.id === 'bizadmin');
      expect(biz).toBeTruthy();
      expect(biz.label).toBe('Business Administration');
      expect(biz.external).toBe(true);                        // deep-links out of the shell
      expect(biz.href).toBe('https://www.advantage.bid/account');
    }
  });

  test('the item is reachable on mobile (primaryMobile → bottom nav, since the rail is hidden ≤860px)', () => {
    const mobile = Nav.primaryMobileNav(Object.assign({ role: 'seller', mode: 'selling' }, BD));
    expect(mobile.map((i) => i.id)).toContain('bizadmin');
  });

  test('native-only accounts (no BD identity) never see Business Administration', () => {
    expect(ids(Nav.visibleNavFor({ role: 'buyer', mode: 'buying' }))).not.toContain('bizadmin');
    // isBdMember true but no URL resolved → still not shown (server withholds the URL for non-members)
    expect(ids(Nav.visibleNavFor({ role: 'buyer', mode: 'buying', isBdMember: true }))).not.toContain('bizadmin');
    // a URL present but not a BD member → not shown
    expect(ids(Nav.visibleNavFor({ role: 'buyer', mode: 'buying', businessAdminUrl: BD.businessAdminUrl }))).not.toContain('bizadmin');
  });

  test('logged-out users never get the item (no role → empty nav)', () => {
    expect(Nav.visibleNavFor(Object.assign({ role: null }, BD))).toEqual([]);
  });

  test('label never exposes a platform/technology name ("Railway")', () => {
    const biz = Nav.visibleNavFor(Object.assign({ role: 'seller', mode: 'selling' }, BD)).find((i) => i.id === 'bizadmin');
    expect(biz.label.toLowerCase()).not.toContain('railway');
  });
});

describe('member shell wires the BD-member flag + Business Administration URL from /me', () => {
  const src = read('public', 'widgets', 'shared', 'member-shell.js');
  test('boot reads bd_member + business_admin_url and feeds them into the nav context', () => {
    expect(src).toContain('me.body.data.bd_member === true');
    expect(src).toContain('me.body.data.business_admin_url');
    expect(src).toMatch(/isBdMember:\s*state\.isBdMember/);
    expect(src).toMatch(/businessAdminUrl:\s*state\.businessAdminUrl/);
  });
});

describe('GET /api/auth/me exposes the BD-member signal (server-authoritative)', () => {
  const auth = read('src', 'routes', 'auth.js');
  const cfg = read('src', 'lib', 'bridgeConfig.js');
  test('/me derives bd_member from a brilliant_directories external identity', () => {
    expect(auth).toMatch(/EXISTS \(SELECT 1 FROM external_identities/);
    expect(auth).toContain("ei.provider = 'brilliant_directories'");
    expect(auth).toContain('bd_member');
  });
  test('business_admin_url is returned ONLY for BD members (null otherwise)', () => {
    expect(auth).toMatch(/business_admin_url: bdMember \? bdMemberAdminUrl\(\) : null/);
  });
  test('the BD admin URL is configurable and must not be BDs bridge/account-home default', () => {
    expect(cfg).toContain('BD_MEMBER_ADMIN_URL');
    expect(cfg).toMatch(/enter-auctions/); // the loop hazard is documented in the config
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

describe('experience switch — shell wiring (Stupid Easy)', () => {
  const src = read('public', 'widgets', 'shared', 'member-shell.js');
  test('mode is persisted and resolved to an allowed experience on boot', () => {
    expect(src).toContain("'ab_active_mode'");
    expect(src).toContain('Nav.resolveMode');
    expect(src).toContain('function switchMode');
  });
  test('a pure buyer sees "Start selling", not a mode switch (chrome rendered by AdvChrome)', () => {
    const chrome = read('public', 'widgets', 'shared', 'member-chrome.js');
    expect(chrome).toContain('Start selling'); // the progressive-disclosure entry lives in the shared chrome
    expect(chrome).toContain('modeSwitch');
    expect(chrome).toMatch(/Switch to /);
    expect(src).toContain('Chrome.rail');       // member-shell delegates its chrome to the shared source
  });
  test('Home, Sell, and Analytics content follow the active mode', () => {
    expect(src).toMatch(/mode === 'selling'\)\s*loadSellerHome/);
    expect(src).toMatch(/case 'sell':\s*return \(state\.mode === 'selling'\)/);
  });
  test('switching resets to Home and re-renders (no stale section)', () => {
    const body = src.slice(src.indexOf('function switchMode'), src.indexOf('function switchMode') + 320);
    expect(body).toContain("state.route = 'home'");
    expect(body).toContain('renderApp()');
    expect(body).toContain('writeMode');
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
  test('logout routes through /logout (clears server cookie + client token) and returns to login', () => {
    // Logout now navigates to the central /logout endpoint, which clears the HttpOnly session
    // cookie server-side, clears the client token, and redirects to the native login page.
    expect(src).toContain('/logout');
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
    expect(src).toContain('href="/"'); // canonical marketplace discovery (was broken /auction.html)
  });
});

describe('buyer sections wired on existing APIs (Watchlist / Purchases / Sellers / Account)', () => {
  const src = read('public', 'widgets', 'shared', 'member-shell.js');
  test('Watchlist: loads + live countdown ticker + sorting + correct remove param', () => {
    expect(src).toContain("apiGet('/api/watchlist')");
    expect(src).toContain("'/api/watchlist/remove'");
    expect(src).toMatch(/lotId:\s*lotId/);         // remove body uses {lotId} (camelCase, matches API)
    expect(src).toContain('data-cd');               // countdown elements
    expect(src).toMatch(/setInterval\(tickTock/);   // live ticker
    for (const s of ['ending', 'auction', 'added']) expect(src).toContain(s); // sort modes
  });
  test('Purchases: combined invoices + PDF + pickup via summary + status timeline', () => {
    expect(src).toContain('/api/invoices/mine/combined');
    expect(src).toContain('/api/invoices/combined/');
    expect(src).toContain("'/api/auctions/'");      // per-auction pickup summary lookup
    expect(src).toContain("'/summary'");
    expect(src).toContain('exact address after payment'); // privacy-safe pre-payment pickup
    expect(src).toContain('stageTimeline');
  });
  test('Sellers: following + reuses public marketplace feed + unfollow', () => {
    expect(src).toContain('/api/sellers/following');
    expect(src).toContain('/api/public/auctions?seller_id=');
    expect(src).toContain('seller_display_name');
    expect(src).toMatch(/method:\s*'DELETE'/);      // unfollow
  });
  test('Account: edits name/phone via PATCH; email read-only; safe links', () => {
    expect(src).toContain("'/api/auth/me'");
    expect(src).toMatch(/method:\s*'PATCH'/);
    expect(src).toContain('full_name');
    expect(src).toContain('/billing.html');
    expect(src).toContain('/forgot-password.html');
    expect(src).toContain('account-managed');       // email shown read-only
  });
  test('the shell never touches Stripe or the bridge directly (payment defers to /invoices.html)', () => {
    for (const s of ['charge-combined', 'charge-lot', 'setup-intent', 'client_secret'])
      expect(src).not.toContain(s);
    expect(src).not.toMatch(/js\.stripe|Stripe\(/);            // no Stripe SDK / client
    expect(src).not.toMatch(/bd\/exchange|bd\/return|BD_BRIDGE/); // never touches the bridge
  });
});

describe('Seller Command Center (Phase 4) — real data only', () => {
  const src = read('public', 'widgets', 'shared', 'member-shell.js');
  test('loads the seller dashboard + settlements reads', () => {
    expect(src).toContain('/api/sellers/me/dashboard');
    expect(src).toContain('/api/seller/settlements/me');
  });
  test('handles the seller-agreement gate (403 → sign)', () => {
    expect(src).toMatch(/status\s*===\s*403/);
    expect(src).toContain('/sign-agreement.html');
  });
  test('quick actions deep-link to the working seller surfaces', () => {
    expect(src).toContain('/seller-create.html');
    expect(src).toContain('#sell'); // in-shell workspace (Issue 2: was /dashboard/seller.html)
    expect(src).toContain('/seller-settlements.html');
  });
  test('surfaces only supported metrics (no fabricated "bids today" / "lots sold")', () => {
    expect(src).toContain('Active auctions');
    expect(src).toContain('Watchers');
    expect(src).toContain('Bidders');
    expect(src).toContain('Gross sales');
    expect(src).not.toContain('Bids today');
    expect(src).not.toContain('Lots sold');
  });
  test('Home follows the active EXPERIENCE (mode), not the raw role', () => {
    expect(src).toMatch(/mode === 'admin'\)\s*loadAdminHome/);
    expect(src).toMatch(/mode === 'selling'\)\s*loadSellerHome/);
    expect(src).toContain('else loadBuyerHome');
  });
});

describe('Unified Member Shell routing correction (Phase B)', () => {
  const server = read('server.js');
  const login = read('public', 'login.html');
  const nav = read('public', 'widgets', 'shared', 'buyer-nav.js');
  test('legacy signed-in pages redirect into the shell (before express.static)', () => {
    const idx = server.indexOf("app.use(express.static");
    const before = server.slice(0, idx);
    expect(before).toMatch(/'\/account', '\/account\.html'.*'\/app\.html#account'/s);
    expect(before).toMatch(/'\/dashboard', '\/dashboard\.html'.*'\/app\.html'/s);
    expect(before).toContain("'/seller-dashboard.html'");
  });
  test('login sends every role to the unified shell (no legacy dashboards)', () => {
    // redirectAfterAuth defaults to the unified shell then navigates (window.location.href = dest).
    expect(login).toContain("'/app.html'");
    expect(login).toContain('window.location.href = dest');
    expect(login).not.toContain('/seller-dashboard.html');
    expect(login).not.toMatch(/href = '\/admin\/index\.html'/);
  });
  test('the header account menu enters the shell, not /account.html', () => {
    expect(nav).toContain('/app.html');
    expect(nav).not.toContain('/account.html');
  });
  test('watchlist unifies to the shell tab; my-bids intentionally kept (no shell view yet)', () => {
    const idx = server.indexOf("app.use(express.static");
    const before = server.slice(0, idx);
    expect(before).toMatch(/'\/watchlist\.html'.*'\/app\.html#watchlist'/s);   // redirect added
    expect(before).not.toMatch(/'\/my-bids\.html'/);                            // my-bids NOT redirected
    expect(nav).toContain('href="/app.html#watchlist"');                        // heart icon points to shell
    expect(nav).not.toContain('/watchlist.html');                              // no legacy watchlist link left in nav
    const home = read('public', 'index.html');
    expect(home).toContain('/app.html#watchlist');                              // marketplace menu Watchlist → shell
    expect(home).toContain('/my-bids.html');                                    // marketplace menu My bids retained
  });
});

describe('Admin Command Center (Phase 6) — operational, real data only', () => {
  const src = read('public', 'widgets', 'shared', 'member-shell.js');
  test('loads the real admin auction queue + Stripe config', () => {
    expect(src).toContain('/api/admin/auctions?state=submitted,under_review,active');
    expect(src).toContain('/api/payments/config');
  });
  test('Stripe mode is derived from the real publishable key (TEST/LIVE), not hardcoded', () => {
    expect(src).toContain("pk_live");
    expect(src).toContain("pk_test");
    expect(src).not.toMatch(/Stripe mode['"]?\s*[:=]\s*['"]TEST['"]/); // not a fabricated constant
  });
  test('attention queue links to the real moderation tool; tools link to existing admin pages', () => {
    expect(src).toContain('/admin/moderation.html');
    for (const p of ['/admin/invoices.html', '/admin/settlement-review.html', '/admin/verification.html',
      '/admin/agreements.html', '/admin/users.html', '/admin/marketplace-config.html', '/admin/index.html'])
      expect(src).toContain(p);
  });
  test('admin Home shows no placeholder stat cards (real counts only)', () => {
    // the old stub used statCard(...'Live auctions') placeholders; admin now loads real data
    expect(src).not.toContain("statCard('🟢', 'Live auctions')");
    expect(src).toContain('loadAdminHome');
  });
});

describe('Seller Workspace + Analytics (Phase 5) — real data, unified experience', () => {
  const src = read('public', 'widgets', 'shared', 'member-shell.js');
  test('Sell workspace organizes auctions by lifecycle (workflow, not a table)', () => {
    for (const g of ['Needs attention', 'Live now', 'Upcoming', 'Under review', 'Drafts', 'Recently closed'])
      expect(src).toContain(g);
    expect(src).toContain('loadSellWorkspace');
  });
  test('Sell renders the workspace in Selling mode, the education/enroll surface otherwise', () => {
    expect(src).toMatch(/case 'sell':\s*return \(state\.mode === 'selling'\)/);
    expect(src).toContain('sellBody');
  });
  test('Analytics surfaces only supported metrics (no fabrication)', () => {
    expect(src).toContain('loadSellerAnalytics');
    for (const m of ['Watchers', 'Bidders', 'Marketing views', 'Gross sales'])
      expect(src).toContain(m);
    expect(src).not.toContain('Conversion rate package'); // guard: no invented reporting metrics
    expect(src).not.toContain('Revenue forecast');
  });
  test('encouraging empty states (celebrate the next action, not "No X")', () => {
    expect(src).toContain('Ready for your first auction?');
    expect(src).not.toMatch(/>No auctions\.?</);
    expect(src).not.toMatch(/>No drafts\.?</);
  });
  test('unified: the seller Home surfaces the member\'s buying attention too', () => {
    expect(src).toContain('Also for you as a buyer');
    expect(src).toContain("apiGet('/api/lots/my-bids')");   // buying side fetched on the seller home
  });
  test('router dispatches sell + analytics loaders', () => {
    expect(src).toMatch(/item === 'sell'\)\s*loadSellWorkspace/);
    expect(src).toMatch(/item === 'analytics'\)\s*loadSellerAnalytics/);
  });
});
