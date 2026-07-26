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
  test('Home routes each role to its own command center', () => {
    expect(src).toMatch(/role === 'admin'\)\s*loadAdminHome/);
    expect(src).toMatch(/else if \(state\.isSeller\)\s*loadSellerHome/);
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
    expect(login).toContain("window.location.href = '/app.html'");
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
  test('Sell is the enroll surface for non-sellers, the workspace for sellers', () => {
    expect(src).toMatch(/case 'sell':\s*return \(state\.isSeller && state\.user\.role !== 'admin'\)/);
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
