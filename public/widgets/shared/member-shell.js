/* ============================================================================
   Advantage Unified Member Shell (Phase 2).
   Renders the premium, role-aware application chrome (rail + header + mobile bottom
   nav) around hash-routed section panels. Phase 2 wires ONLY real identity/role data
   (GET /api/auth/me + GET /api/sellers/me) to prove navigation behavior; section
   bodies are intentional "coming in Phase 3" stubs. Additive: loaded only by the
   parallel /app.html route. Native login and all existing pages are untouched.
   ========================================================================== */
(function () {
  'use strict';
  var Nav = (typeof window !== 'undefined' && window.AdvNav);
  var LOGIN = '/login.html?next=' + encodeURIComponent('/app.html');
  var mountEl, state = { user: null, isSeller: false, sellerType: null, route: 'home' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function token() { try { return localStorage.getItem('token'); } catch (e) { return null; } }

  async function apiGet(path) {
    var res = await fetch(path, { headers: { Authorization: 'Bearer ' + token() } });
    var body = null; try { body = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, body: body };
  }

  // ---- top-level states ----
  function shell(inner) { return '<div class="adv-center">' + inner + '</div>'; }
  function renderLoading() { mountEl.innerHTML =
    '<div class="adv">' + shell('<div><div class="adv-spinner" style="margin:0 auto 14px"></div>' +
    '<div class="adv-muted">Loading your Advantage account…</div></div>') + '</div>'; }

  function renderLoggedOut() { mountEl.innerHTML = '<div class="adv">' + shell(
    '<div class="adv-empty"><span class="emoji">🔐</span><h3>Please sign in</h3>' +
    '<p>Sign in to open your Advantage member dashboard.</p>' +
    '<p style="margin-top:14px"><a class="adv-btn primary" href="' + LOGIN + '">Sign in</a></p></div>') + '</div>'; }

  function renderUnauthorized() { mountEl.innerHTML = '<div class="adv">' + shell(
    '<div class="adv-empty"><span class="emoji">⏳</span><h3>Your session expired</h3>' +
    '<p>For your security, please sign in again.</p>' +
    '<p style="margin-top:14px"><a class="adv-btn primary" href="' + LOGIN + '">Sign in</a></p></div>') + '</div>'; }

  function renderError() { mountEl.innerHTML = '<div class="adv">' + shell(
    '<div class="adv-empty"><span class="emoji">⚠️</span><h3>Something went wrong</h3>' +
    '<p>We couldn\'t load your dashboard just now.</p>' +
    '<p style="margin-top:14px"><button class="adv-btn primary" id="adv-retry">Try again</button></p></div>') + '</div>';
    var b = document.getElementById('adv-retry'); if (b) b.addEventListener('click', boot); }

  // ---- chrome ----
  function initials(u) { var n = (u.full_name || u.email || '?').trim();
    var p = n.split(/\s+/); return ((p[0] || '')[0] || '' ) + (p.length > 1 ? (p[p.length - 1][0] || '') : ''); }

  function navCtx() { return { role: state.user.role, isSeller: state.isSeller }; }

  function navItemHtml(item, mobile) {
    var cur = item.id === state.route ? ' aria-current="page"' : '';
    return '<a class="adv-nav-item" href="' + item.href + '" data-route="' + item.id + '"' + cur + '>' +
      '<span class="adv-nav-emoji" aria-hidden="true">' + item.emoji + '</span>' +
      '<span>' + esc(item.label) + '</span></a>';
  }

  function railHtml() {
    var items = Nav.visibleNavFor(navCtx()).map(function (i) { return navItemHtml(i, false); }).join('');
    return '<aside class="adv-rail">' +
      '<div class="adv-brand"><div class="adv-brand-mark">A</div>' +
        '<div><div class="adv-brand-name">Advantage</div><div class="adv-brand-sub">Member dashboard</div></div></div>' +
      '<nav class="adv-nav" aria-label="Primary">' + items + '</nav>' +
      '<div class="adv-rail-foot"><button class="adv-nav-item" id="adv-logout">' +
        '<span class="adv-nav-emoji" aria-hidden="true">↩︎</span><span>Log out</span></button></div>' +
    '</aside>';
  }

  function bottomNavHtml() {
    var items = Nav.primaryMobileNav(navCtx()).map(function (i) { return navItemHtml(i, true); }).join('');
    return '<nav class="adv-bottomnav" aria-label="Primary mobile">' + items + '</nav>';
  }

  function headerHtml() {
    var u = state.user, roleLabel = state.isSeller && u.role === 'buyer' ? 'Buyer · Seller' : u.role;
    return '<header class="adv-header">' +
      '<div class="adv-mobile-brand"><div class="adv-brand-mark">A</div><div class="adv-brand-name">Advantage</div></div>' +
      '<h1 id="adv-title">Home</h1><div class="adv-header-spacer"></div>' +
      '<button class="adv-icon-btn" id="adv-bell" aria-label="Updates and notifications">🔔<span class="adv-dot"></span></button>' +
      '<div class="adv-user"><div class="adv-avatar" aria-hidden="true">' + esc(initials(u).toUpperCase()) + '</div>' +
        '<div class="adv-user-meta"><div class="adv-user-name">' + esc(u.full_name || u.email) + '</div>' +
        '<div class="adv-user-role">' + esc(roleLabel) + '</div></div></div>' +
    '</header>';
  }

  function frameHtml() {
    return '<div class="adv"><div class="adv-app">' + railHtml() + headerHtml() +
      '<main class="adv-main" id="adv-main"></main>' + bottomNavHtml() + '</div></div>';
  }

  // ---- Phase-2 section stubs (bodies land in Phase 3+) ----
  function stub(emoji, title, line) {
    return '<div class="adv-card"><div class="adv-empty"><span class="emoji">' + emoji + '</span>' +
      '<h3>' + esc(title) + '</h3><p>' + esc(line) + '</p></div></div>';
  }
  function statCard(emoji, label) {
    return '<div class="adv-card adv-stat"><div class="adv-stat-top"><span class="adv-stat-emoji">' + emoji +
      '</span><span class="adv-chip info">soon</span></div><div class="adv-stat-num">—</div>' +
      '<div class="adv-stat-label">' + esc(label) + '</div></div>';
  }
  function greetingHtml(sub) {
    var u = state.user, hi = (u.full_name || u.email || '').split(/\s+/)[0] || 'there';
    return '<div style="font-size:21px;font-weight:800;letter-spacing:-.015em;margin:0 2px 2px">Welcome back, ' + esc(hi) + '</div>' +
      '<div class="adv-muted" id="adv-home-status" style="margin:2px 2px 16px;font-size:13.5px">' + esc(sub || '') + '</div>';
  }
  function homeBody() {
    var u = state.user;
    if (u.role !== 'admin' && !state.isSeller) {
      var sk = '';
      for (var i = 0; i < 4; i++) sk += '<div class="adv-card"><div class="adv-skeleton" style="width:44%"></div>' +
        '<div class="adv-skeleton" style="height:26px;width:52%;margin-top:12px"></div></div>';
      return greetingHtml('Loading your latest activity…') + '<div id="adv-home-live"><div class="adv-grid">' + sk + '</div></div>';
    }
    var cards, note;
    if (u.role === 'admin') {
      cards = [statCard('🟢', 'Live auctions'), statCard('🕒', 'Ending soon'), statCard('✅', 'Awaiting approval'),
               statCard('🧾', 'Invoice issues'), statCard('💳', 'Stripe mode'), statCard('📡', 'Sync health')];
      note = 'Your administrator command center. Live operational tiles arrive in Phase 6.';
    } else {
      cards = [statCard('🟢', 'Active auctions'), statCard('✏️', 'Drafts'), statCard('🔨', 'Bids today'),
               statCard('🧾', 'Unpaid invoices'), statCard('📦', 'Pickups'), statCard('💰', 'Gross sales')];
      note = 'Your seller command center. Live metrics and quick actions arrive in Phase 4.';
    }
    return greetingHtml(note) + '<div class="adv-grid">' + cards.join('') + '</div>';
  }

  // ---- Buyer Home — live data (Phase 3), attention-first ----
  function money(c) { try { if (window.BidUtils && window.BidUtils.formatUSD) return window.BidUtils.formatUSD(c); } catch (e) {}
    return '$' + ((Number(c) || 0) / 100).toFixed(2); }
  function classifyKey(lot) { try { if (window.BidStatus && window.BidStatus.deriveBidderStatus) return window.BidStatus.deriveBidderStatus(lot).key; } catch (e) {}
    return lot.viewer_is_high_bidder ? 'winning' : (lot.viewer_has_bid ? 'outbid' : 'watching'); }
  function msLeft(iso) { if (!iso) return null; return new Date(iso).getTime() - Date.now(); }
  function timeLeft(iso) { var ms = msLeft(iso); if (ms == null) return ''; if (ms <= 0) return 'Ended';
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return d + 'd ' + (h % 24) + 'h'; if (h >= 1) return h + 'h ' + (m % 60) + 'm'; return Math.max(1, m) + 'm'; }
  function isPayable(i) { return ['issued', 'unpaid', 'payment_required', 'failed', 'payment_failed'].indexOf(String(i.status || '').toLowerCase()) !== -1; }

  function statLink(href, emoji, num, label, tone, chipText) {
    return '<a class="adv-card adv-stat" href="' + href + '" style="text-decoration:none;color:inherit">' +
      '<div class="adv-stat-top"><span class="adv-stat-emoji">' + emoji + '</span>' +
      (num > 0 && tone ? '<span class="adv-chip ' + tone + '">' + esc(chipText) + '</span>' : '') + '</div>' +
      '<div class="adv-stat-num">' + num + '</div><div class="adv-stat-label">' + esc(label) + '</div></a>';
  }
  function attnRow(emoji, tone, title, sub, cta) {
    return '<div class="adv-row" style="justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line)">' +
      '<div class="adv-row" style="gap:11px;min-width:0"><span class="adv-chip ' + tone + '" style="flex:none">' + emoji + '</span>' +
      '<div style="min-width:0"><div style="font-weight:700;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(title) + '</div>' +
      '<div class="adv-muted" style="font-size:12px">' + esc(sub) + '</div></div></div>' + cta + '</div>';
  }
  function endRow(l) {
    var k = classifyKey(l), tone = k === 'winning' ? 'good' : (k === 'outbid' ? 'bad' : 'info'),
        kl = k === 'winning' ? 'Winning' : (k === 'outbid' ? 'Outbid' : 'Watching');
    return '<div class="adv-row" style="justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--line)">' +
      '<div style="min-width:0"><div style="font-weight:700;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
        (l.lot_number != null ? ('#' + esc(l.lot_number) + ' ') : '') + esc(l.title || 'Lot') + '</div>' +
      '<div class="adv-row" style="gap:8px;margin-top:3px"><span class="adv-chip ' + tone + '">' + kl + '</span>' +
      '<span class="adv-muted" style="font-size:12px">Current ' + money(l.current_bid_cents) + '</span></div></div>' +
      '<div style="text-align:right;flex:none"><span class="adv-chip warn">⏳ ' + esc(timeLeft(l.closes_at)) + '</span>' +
      '<div style="margin-top:6px"><a class="adv-btn ghost" style="padding:6px 12px" href="/lot.html?id=' + encodeURIComponent(l.id) + '">View</a></div></div></div>';
  }

  async function loadBuyerHome() {
    var host = document.getElementById('adv-home-live'); if (!host) return;
    var r = await Promise.all([
      apiGet('/api/watchlist').catch(function () { return { ok: false }; }),
      apiGet('/api/lots/my-bids').catch(function () { return { ok: false }; }),
      apiGet('/api/invoices/mine/combined').catch(function () { return { ok: false }; }),
      apiGet('/api/sellers/following').catch(function () { return { ok: false }; })
    ]);
    if (state.route !== 'home') return; // user navigated away while loading
    var watch = (r[0].ok && r[0].body && r[0].body.data) || [];
    var bids = (r[1].ok && r[1].body && r[1].body.data) || [];
    var inv = (r[2].ok && r[2].body && r[2].body.invoices) || [];
    var follow = (r[3].ok && r[3].body && r[3].body.data) || [];

    var openWatch = watch.filter(function (l) { return l.state === 'open'; });
    var openBids = bids.filter(function (l) { return l.state === 'open'; });
    var winning = openBids.filter(function (l) { return classifyKey(l) === 'winning'; });
    var outbid = openBids.filter(function (l) { return classifyKey(l) === 'outbid'; });
    var unpaid = inv.filter(isPayable);

    var attn = '';
    unpaid.slice(0, 3).forEach(function (i) {
      attn += attnRow('💳', 'warn', 'Payment due — ' + (i.auction_title || 'Auction'),
        money(i.total_cents) + ' · Invoice ' + (i.invoice_number || ''),
        '<a class="adv-btn primary" style="flex:none" href="/invoices.html">Pay now</a>'); });
    outbid.slice(0, 3).forEach(function (l) {
      attn += attnRow('🔁', 'bad', "You've been outbid — " + (l.title || 'Lot'),
        'Current bid ' + money(l.current_bid_cents) + ' · ends ' + timeLeft(l.closes_at),
        '<a class="adv-btn ghost" style="flex:none" href="/lot.html?id=' + encodeURIComponent(l.id) + '">Re-bid</a>'); });
    var attnCard = attn
      ? '<div class="adv-card"><div style="font-weight:800;font-size:14px">Needs your attention</div>' + attn + '</div>'
      : '<div class="adv-card"><div class="adv-empty" style="padding:22px"><span class="emoji">🎉</span><h3>You\'re all caught up</h3><p>No payments due and no lots need action right now.</p></div></div>';

    var bits = [];
    if (unpaid.length) bits.push(unpaid.length + ' payment' + (unpaid.length > 1 ? 's' : '') + ' due');
    if (outbid.length) bits.push(outbid.length + ' outbid');
    if (winning.length) bits.push(winning.length + ' winning');
    var st = document.getElementById('adv-home-status');
    if (st) st.textContent = bits.length ? ('You have ' + bits.join(' · ') + '.')
      : ("You're watching " + openWatch.length + ' lot' + (openWatch.length === 1 ? '' : 's') + '. Nothing needs action.');

    var chips = '<div class="adv-grid" style="margin:0 0 16px">' +
      statLink('#watchlist', '👀', openWatch.length, 'Watching', null) +
      statLink('#auctions', '🏆', winning.length, 'Winning', 'good', '✓') +
      statLink('#auctions', '🔁', outbid.length, 'Outbid', 'bad', 'action') +
      statLink('#purchases', '💳', unpaid.length, 'Payment due', 'warn', 'pay') + '</div>';

    var byId = {};
    openWatch.concat(openBids).forEach(function (l) { if (l.closes_at && msLeft(l.closes_at) > 0) byId[l.id] = l; });
    var ending = Object.keys(byId).map(function (k) { return byId[k]; })
      .sort(function (a, b) { return new Date(a.closes_at) - new Date(b.closes_at); }).slice(0, 5);
    var endCard = ending.length
      ? '<div class="adv-section-title">What\'s happening</div><div class="adv-card">' +
        '<div class="adv-row" style="justify-content:space-between"><div style="font-weight:800;font-size:14px">Ending soon</div>' +
        '<a class="adv-chip info" href="#watchlist" style="text-decoration:none">Watchlist</a></div>' + ending.map(endRow).join('') + '</div>'
      : '';

    var actions = '<div class="adv-section-title">Quick actions</div><div class="adv-row adv-wrap">' +
      '<a class="adv-btn primary" href="/auction.html">🔨 Browse auctions</a>' +
      '<a class="adv-btn ghost" href="#watchlist">❤️ Watchlist</a>' +
      '<a class="adv-btn ghost" href="#purchases">📦 Purchases</a>' +
      '<a class="adv-btn ghost" href="#sellers">🏪 Following (' + follow.length + ')</a></div>';

    host.innerHTML = chips + attnCard + endCard + actions;
  }

  function sellBody() {
    if (state.isSeller) return stub('📈', 'Sell — command center', 'Create & manage auctions, lots, settlements and payouts. Full experience arrives in Phase 4.');
    return '<div class="adv-card"><div class="adv-empty"><span class="emoji">📈</span>' +
      '<h3>Sell with Advantage</h3><p>List with Advantage as a private seller or professional auction house. ' +
      'Learn how it works and get started.</p><p style="margin-top:14px">' +
      '<a class="adv-btn primary" href="/become-seller.html">Start selling</a> ' +
      '<a class="adv-btn ghost" href="/start-selling.html">How it works</a></p></div></div>';
  }

  function sectionBody(route) {
    switch (route) {
      case 'home':      return homeBody();
      case 'auctions':  return stub('🔨', 'Auctions', 'Browse live auctions, ending soon, and the ones you\'ve bid in. Wires to the canonical marketplace in Phase 3.');
      case 'watchlist': return stub('❤️', 'Watchlist', 'Your watched lots with live bid status and time remaining. Wires to your watchlist in Phase 3.');
      case 'purchases': return stub('📦', 'Purchases', 'Won lots, invoices, payments, receipts and pickup details. Wires to your combined invoices in Phase 3.');
      case 'sellers':   return stub('🏪', 'Sellers', 'Sellers you follow and marketplace profiles. Wires to your follows in Phase 3.');
      case 'sell':      return sellBody();
      case 'analytics': return stub('📊', 'Analytics', 'Meaningful performance and activity metrics, built on real captured data. Arrives in Phase 5.');
      case 'messages':  return '<div class="adv-card"><div class="adv-row" style="justify-content:space-between;margin-bottom:6px">' +
                          '<div style="font-weight:800">Updates &amp; Notifications</div>' +
                          '<span class="adv-chip accent">Conversations — coming later</span></div>' +
                          '<div class="adv-empty"><span class="emoji">💬</span><h3>Your updates inbox</h3>' +
                          '<p>Outbid alerts, payment reminders, pickup notices, new auctions from sellers you follow, and account updates — all in one place. This is an updates &amp; notifications inbox, not two-way messaging (that comes later). Wires to your notifications in Phase 5.</p></div></div>';
      case 'account':   return stub('⚙️', 'Account', 'Manage your profile, notification preferences, payment methods and security. Some identity fields are managed in your Advantage.bid member account. Arrives in Phase 3.');
      default:          return homeBody();
    }
  }

  function setRoute(route) {
    var item = Nav.byId(route) && Nav.visibleNavFor(navCtx()).some(function (i) { return i.id === route; }) ? route : 'home';
    state.route = item;
    var main = document.getElementById('adv-main'); if (main) main.innerHTML = sectionBody(item);
    if (item === 'home' && document.getElementById('adv-home-live')) loadBuyerHome();
    var title = document.getElementById('adv-title'); var navItem = Nav.byId(item);
    if (title && navItem) title.textContent = navItem.label;
    document.querySelectorAll('.adv-nav-item[data-route]').forEach(function (a) {
      if (a.getAttribute('data-route') === item) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    try { if (('#' + item) !== location.hash) history.replaceState(null, '', '#' + item); } catch (e) {}
  }

  function wire() {
    document.querySelectorAll('.adv-nav-item[data-route]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); setRoute(a.getAttribute('data-route')); });
    });
    var lo = document.getElementById('adv-logout');
    if (lo) lo.addEventListener('click', function () { try { localStorage.removeItem('token'); } catch (e) {} location.href = '/login.html'; });
    var bell = document.getElementById('adv-bell');
    if (bell) bell.addEventListener('click', function () { setRoute('messages'); });
    window.addEventListener('hashchange', function () { setRoute((location.hash || '#home').slice(1)); });
  }

  function renderApp() {
    mountEl.innerHTML = frameHtml();
    wire();
    setRoute((location.hash || '#home').slice(1));
  }

  async function boot() {
    renderLoading();
    if (!token()) return renderLoggedOut();
    try {
      var me = await apiGet('/api/auth/me');
      if (me.status === 401) return renderUnauthorized();
      if (!me.ok || !me.body || !me.body.data) return renderError();
      state.user = me.body.data;
      // seller detail is best-effort; a non-seller simply has no profile
      try {
        var s = await apiGet('/api/sellers/me');
        var sp = s.ok && s.body && (s.body.data || s.body);
        state.isSeller = !!(sp && (sp.seller_profile || sp.seller_type || sp.id));
        state.sellerType = sp && (sp.seller_type || (sp.seller_profile && sp.seller_profile.seller_type)) || null;
      } catch (e) { state.isSeller = false; }
      renderApp();
    } catch (e) { renderError(); }
  }

  function start() {
    mountEl = document.getElementById('adv-shell-root');
    if (!mountEl || !Nav) return;
    boot();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
