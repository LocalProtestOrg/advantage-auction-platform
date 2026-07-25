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
    if (u.role === 'admin') {
      var cards = [statCard('🟢', 'Live auctions'), statCard('🕒', 'Ending soon'), statCard('✅', 'Awaiting approval'),
               statCard('🧾', 'Invoice issues'), statCard('💳', 'Stripe mode'), statCard('📡', 'Sync health')];
      return greetingHtml('Your administrator command center. Live operational tiles arrive in Phase 6.') +
        '<div class="adv-grid">' + cards.join('') + '</div>';
    }
    var sk = '';
    for (var i = 0; i < 4; i++) sk += '<div class="adv-card"><div class="adv-skeleton" style="width:44%"></div>' +
      '<div class="adv-skeleton" style="height:26px;width:52%;margin-top:12px"></div></div>';
    return greetingHtml(state.isSeller ? 'Loading your business…' : 'Loading your latest activity…') +
      '<div id="adv-home-live"><div class="adv-grid">' + sk + '</div></div>';
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

  // ================= SELLER HOME (Phase 4) — the Seller Command Center =================
  function metricCard(emoji, value, label) {
    return '<div class="adv-card adv-stat"><div class="adv-stat-top"><span class="adv-stat-emoji">' + emoji + '</span></div>' +
      '<div class="adv-stat-num">' + esc(String(value)) + '</div><div class="adv-stat-label">' + esc(label) + '</div></div>'; }
  function stateLabel(s) { var m = { draft: 'Draft', submitted: 'Submitted for review', under_review: 'Under review',
    published: 'Published', active: 'Live now', closed: 'Closed', rejected: 'Needs changes' }; return m[s] || s; }
  function relTime(iso) { if (!iso) return ''; var ms = Date.now() - new Date(iso).getTime(); if (ms < 0) return 'just now';
    var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return d + 'd ago'; if (h >= 1) return h + 'h ago'; if (m >= 1) return m + 'm ago'; return 'just now'; }
  function sEdit(id, label) { return '<a class="adv-btn primary" style="flex:none;padding:7px 13px" href="/seller-create.html?id=' + encodeURIComponent(id) + '">' + esc(label) + '</a>'; }
  function sView(id, label) { return '<a class="adv-btn ghost" style="flex:none;padding:7px 13px" href="/auction-view.html?id=' + encodeURIComponent(id) + '">' + esc(label) + '</a>'; }

  // ---- Sell workspace (auction management, organized by lifecycle) ----
  function sellerNextAction(a) {
    var s = a.state;
    if (s === 'draft' || s === 'rejected') return sEdit(a.id, s === 'rejected' ? 'Revise' : (a.revision_note ? 'Edit' : 'Continue'));
    if (s === 'submitted' || s === 'under_review') return '<a class="adv-btn ghost" style="flex:none;padding:7px 13px" href="/seller-create.html?id=' + encodeURIComponent(a.id) + '">View</a>';
    return sView(a.id, s === 'closed' ? 'Results' : 'Manage');
  }
  function auctionCard(a) {
    var s = a.state, tone = { draft: 'info', submitted: 'accent', under_review: 'accent', published: 'good', active: 'good', closed: 'info', rejected: 'bad' }[s] || 'info';
    var timing = '';
    if (s === 'active' || s === 'published') timing = a.end_time ? ('Ends ' + (fmtWindow(a.end_time) || relTime(a.end_time))) : '';
    else if (s === 'closed') timing = a.end_time ? ('Closed ' + relTime(a.end_time)) : '';
    else timing = 'Created ' + relTime(a.created_at);
    var reason = a.rejection_reason || a.revision_note || '';
    return '<div class="adv-card"><div class="adv-row" style="justify-content:space-between;gap:10px">' +
      '<div style="min-width:0"><div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(a.title || 'Untitled auction') + '</div>' +
      '<div class="adv-row" style="gap:8px;margin-top:5px;flex-wrap:wrap"><span class="adv-chip ' + tone + '">' + esc(stateLabel(s)) + '</span>' +
      (timing ? ('<span class="adv-muted" style="font-size:12px">' + esc(timing) + '</span>') : '') +
      (reason ? ('<span class="adv-muted" style="font-size:12px">· ' + esc(reason) + '</span>') : '') + '</div></div>' +
      sellerNextAction(a) + '</div></div>';
  }
  async function loadSellWorkspace() {
    var r = await apiGet('/api/sellers/me/dashboard').catch(function () { return { ok: false }; });
    if (state.route !== 'sell') return;
    var host = document.getElementById('adv-sec-live'); if (!host) return;
    if (r.status === 403) { host.innerHTML = emptyCard('📝', 'Complete your seller agreement',
      'Sign your Advantage seller agreement to open your workspace.', '<a class="adv-btn primary" href="/sign-agreement.html">Review &amp; sign</a>'); return; }
    var auctions = (r.ok && r.body && r.body.data && r.body.data.auctions) || [];
    if (!auctions.length) { host.innerHTML = emptyCard('🚀', 'Ready for your first auction?',
      "List your first auction and start receiving bids — we'll guide you through it.", '<a class="adv-btn primary" href="/seller-create.html">Create auction</a>'); return; }
    var g = { needs: [], live: [], upcoming: [], review: [], draft: [], closed: [] };
    auctions.forEach(function (a) {
      if (a.state === 'rejected' || (a.state === 'draft' && a.revision_note)) g.needs.push(a);
      else if (a.state === 'active') g.live.push(a);
      else if (a.state === 'published') g.upcoming.push(a);
      else if (a.state === 'submitted' || a.state === 'under_review') g.review.push(a);
      else if (a.state === 'draft') g.draft.push(a);
      else if (a.state === 'closed') g.closed.push(a);
    });
    var group = function (title, list, emoji) { return list.length
      ? '<div class="adv-section-title">' + emoji + ' ' + title + ' (' + list.length + ')</div><div style="display:grid;gap:12px">' + list.map(auctionCard).join('') + '</div>' : ''; };
    host.innerHTML =
      '<div class="adv-row" style="justify-content:space-between;margin:0 2px 14px;flex-wrap:wrap;gap:8px">' +
        '<div class="adv-muted" style="font-size:13.5px">' + auctions.length + ' auction' + (auctions.length === 1 ? '' : 's') + '</div>' +
        '<a class="adv-btn primary" href="/seller-create.html" style="padding:8px 14px">➕ Create auction</a></div>' +
      group('Needs attention', g.needs, '⚠️') + group('Live now', g.live, '🟢') + group('Upcoming', g.upcoming, '🗓️') +
      group('Under review', g.review, '🔎') + group('Drafts', g.draft, '📝') + group('Recently closed', g.closed, '✅');
  }

  // ---- Seller analytics (real, decision-supporting metrics only) ----
  async function loadSellerAnalytics() {
    var r = await Promise.all([
      apiGet('/api/sellers/me/dashboard').catch(function () { return { ok: false }; }),
      apiGet('/api/seller/settlements/me').catch(function () { return { ok: false }; })
    ]);
    if (state.route !== 'analytics') return;
    var host = document.getElementById('adv-sec-live'); if (!host) return;
    if (r[0].status === 403) { host.innerHTML = emptyCard('📝', 'Complete your seller agreement',
      'Sign your agreement to see how your auctions are performing.', '<a class="adv-btn primary" href="/sign-agreement.html">Review &amp; sign</a>'); return; }
    var d = (r[0].ok && r[0].body && r[0].body.data) || { summary: {}, auctions: [] };
    var sum = d.summary || {}, auctions = d.auctions || [], fin = (r[1].ok && r[1].body && r[1].body.data) || null;
    if (!auctions.length) { host.innerHTML = emptyCard('📊', 'Your numbers will appear here',
      "Once you run an auction, you'll see watchers, bidders, and sales at a glance.", '<a class="adv-btn primary" href="/seller-create.html">Create auction</a>'); return; }
    var cards = '<div class="adv-grid" style="margin:0 0 8px">' +
      metricCard('👀', sum.total_watchlist_adds || 0, 'Watchers') +
      metricCard('🙋', sum.total_bidder_conversions || 0, 'Bidders') +
      metricCard('📣', sum.total_views || 0, 'Marketing views') +
      (fin ? metricCard('💰', money((fin.summary && fin.summary.lifetime_gross_cents) || 0), 'Gross sales') : '') +
      (fin ? metricCard('🏦', (fin.summary && fin.summary.total_settled) || 0, 'Settled auctions') : '') +
      (fin ? metricCard('⏳', (fin.summary && fin.summary.pending_settlements) || 0, 'Pending payouts') : '') + '</div>';
    var perf = auctions.filter(function (a) { return (Number(a.watchlist_adds) || 0) + (Number(a.bidder_conversions) || 0) > 0; })
      .sort(function (a, b) { return (Number(b.bidder_conversions) || 0) - (Number(a.bidder_conversions) || 0) || (Number(b.watchlist_adds) || 0) - (Number(a.watchlist_adds) || 0); }).slice(0, 6);
    var perfCard = perf.length ? ('<div class="adv-section-title">Auction performance</div><div class="adv-card">' +
      perf.map(function (a) { var w = Number(a.watchlist_adds) || 0, bd = Number(a.bidder_conversions) || 0, conv = w ? Math.round(bd / w * 100) : null;
        return '<div class="adv-row" style="justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--line)">' +
          '<div style="min-width:0"><div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(a.title || 'Auction') + '</div>' +
          '<div class="adv-muted" style="font-size:11.5px">' + esc(stateLabel(a.state)) + '</div></div>' +
          '<div class="adv-row" style="gap:8px;flex:none"><span class="adv-chip info">👀 ' + w + '</span><span class="adv-chip accent">🙋 ' + bd + '</span>' +
          (conv != null ? ('<span class="adv-chip good">' + conv + '%</span>') : '') + '</div></div>'; }).join('') + '</div>') : '';
    host.innerHTML = '<div class="adv-muted" style="margin:0 2px 14px;font-size:13.5px">How your auctions are performing — real numbers only.</div>' + cards + perfCard;
  }

  async function loadSellerHome() {
    var host = document.getElementById('adv-home-live'); if (!host) return;
    var r = await Promise.all([
      apiGet('/api/sellers/me/dashboard').catch(function () { return { ok: false }; }),
      apiGet('/api/seller/settlements/me').catch(function () { return { ok: false }; }),
      apiGet('/api/lots/my-bids').catch(function () { return { ok: false }; }),          // unified: their buying side too
      apiGet('/api/invoices/mine/combined').catch(function () { return { ok: false }; })
    ]);
    if (state.route !== 'home') return;
    var setStatus = function (t) { var s = document.getElementById('adv-home-status'); if (s) s.textContent = t; };
    if (r[0].status === 403) { // seller agreement not yet signed
      host.innerHTML = emptyCard('📝', 'Complete your seller agreement',
        'Sign your Advantage seller agreement to open your dashboard and start listing.', '<a class="adv-btn primary" href="/sign-agreement.html">Review &amp; sign</a>');
      setStatus('One quick step to get started.'); return;
    }
    var d = (r[0].ok && r[0].body && r[0].body.data) || { summary: {}, auctions: [] };
    var auctions = d.auctions || [], sum = d.summary || {};
    var fin = (r[1].ok && r[1].body && r[1].body.data) || null;
    if (!auctions.length) {
      host.innerHTML = emptyCard('🚀', 'Welcome to your Seller Command Center',
        "List your first auction and start receiving bids — we'll guide you through it.", '<a class="adv-btn primary" href="/seller-create.html">Create your first auction</a>');
      setStatus("Let's get your first auction live."); return;
    }

    var drafts = auctions.filter(function (a) { return a.state === 'draft' && !a.revision_note; });
    var rejected = auctions.filter(function (a) { return a.state === 'rejected'; });
    var revision = auctions.filter(function (a) { return a.revision_note && a.state === 'draft'; });
    var live = auctions.filter(function (a) { return a.state === 'published' || a.state === 'active'; });
    var ending = live.filter(function (a) { var ms = a.end_time ? new Date(a.end_time) - Date.now() : null; return ms != null && ms > 0 && ms < 48 * 3600 * 1000; });

    var attn = '';
    rejected.slice(0, 3).forEach(function (a) { attn += attnRow('⚠️', 'bad', 'Needs changes — ' + (a.title || 'Auction'), a.rejection_reason || 'Advantage requested changes', sEdit(a.id, 'Revise')); });
    revision.slice(0, 3).forEach(function (a) { attn += attnRow('✏️', 'warn', 'Revision requested — ' + (a.title || 'Auction'), a.revision_note || 'Please update and resubmit', sEdit(a.id, 'Edit')); });
    drafts.slice(0, 3).forEach(function (a) { attn += attnRow('📝', 'info', 'Finish your draft — ' + (a.title || 'Untitled auction'), 'Complete and submit for review', sEdit(a.id, 'Continue')); });
    ending.slice(0, 3).forEach(function (a) { attn += attnRow('⏳', 'warn', 'Ending soon — ' + (a.title || 'Auction'), 'Ends ' + timeLeft(a.end_time), sView(a.id, 'View')); });
    var attnCard = attn
      ? '<div class="adv-card"><div style="font-weight:800;font-size:14px">Needs your attention</div>' + attn + '</div>'
      : '<div class="adv-card"><div class="adv-empty" style="padding:22px"><span class="emoji">✅</span><h3>Everything\'s running smoothly</h3><p>No auctions need action right now.</p></div></div>';

    var bits = [];
    if (rejected.length) bits.push(rejected.length + ' needing changes');
    if (drafts.length) bits.push(drafts.length + ' draft' + (drafts.length > 1 ? 's' : ''));
    if (ending.length) bits.push(ending.length + ' ending soon');
    setStatus(bits.length ? ('You have ' + bits.join(' · ') + '.') : (live.length + ' auction' + (live.length === 1 ? '' : 's') + ' live. All running smoothly.'));

    var biz = '<div class="adv-section-title">Business today</div><div class="adv-grid" style="margin:0 0 4px">' +
      statLink('/dashboard/seller.html', '🟢', live.length, 'Active auctions', live.length ? 'good' : null, 'live') +
      statLink('/dashboard/seller.html', '📝', drafts.length, 'Drafts', drafts.length ? 'warn' : null, 'finish') +
      metricCard('👀', sum.total_watchlist_adds || 0, 'Watchers') +
      metricCard('🙋', sum.total_bidder_conversions || 0, 'Bidders') +
      (fin ? metricCard('💰', money((fin.summary && fin.summary.lifetime_gross_cents) || 0), 'Gross sales') : '') +
      (fin ? statLink('/seller-settlements.html', '🏦', (fin.summary && fin.summary.pending_settlements) || 0, 'Pending payouts', (fin.summary && fin.summary.pending_settlements > 0) ? 'info' : null, 'view') : '') +
      '</div>';

    var actions = '<div class="adv-section-title">Quick actions</div><div class="adv-row adv-wrap">' +
      '<a class="adv-btn primary" href="/seller-create.html">➕ Create auction</a>' +
      '<a class="adv-btn ghost" href="/dashboard/seller.html">🗂️ Manage auctions</a>' +
      '<a class="adv-btn ghost" href="/dashboard/seller.html">📝 Drafts</a>' +
      '<a class="adv-btn ghost" href="/seller-settlements.html">💰 Settlements</a></div>';

    var acts = auctions.slice(0, 6).map(function (a) {
      var editable = a.state === 'draft' || a.state === 'rejected';
      return '<div class="adv-row" style="justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--line)">' +
        '<div style="min-width:0"><div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(a.title || 'Untitled auction') + '</div>' +
        '<div class="adv-muted" style="font-size:11.5px">' + esc(stateLabel(a.state)) + ' · ' + relTime(a.created_at) + '</div></div>' +
        (editable ? sEdit(a.id, 'Edit') : sView(a.id, 'View')) + '</div>'; }).join('');
    var activityCard = '<div class="adv-section-title">Recent activity</div><div class="adv-card">' + acts + '</div>';

    // Unified: this seller is also a buyer — surface their buying attention in one glance.
    var bBids = (r[2].ok && r[2].body && r[2].body.data) || [];
    var bInv = (r[3].ok && r[3].body && r[3].body.invoices) || [];
    var outbidN = bBids.filter(function (l) { return l.state === 'open' && classifyKey(l) === 'outbid'; }).length;
    var dueN = bInv.filter(isPayable).length;
    var buyBanner = (outbidN || dueN)
      ? '<a href="#' + (dueN ? 'purchases' : 'auctions') + '" style="text-decoration:none"><div class="adv-card" style="background:var(--accent-wash);border-color:transparent;margin-bottom:14px">' +
        '<div class="adv-row" style="justify-content:space-between;gap:10px"><div class="adv-row" style="gap:10px"><span style="font-size:17px">🛍️</span>' +
        '<div style="font-weight:700;font-size:13px;color:var(--accent-ink)">Also for you as a buyer</div></div>' +
        '<div style="font-size:12.5px;color:var(--accent-ink)">' + [dueN ? (dueN + ' payment' + (dueN > 1 ? 's' : '') + ' due') : '', outbidN ? (outbidN + ' outbid') : ''].filter(Boolean).join(' · ') + ' ›</div></div></div></a>'
      : '';

    host.innerHTML = buyBanner + attnCard + biz + actions + activityCard;
  }

  // ---- shared section helpers ----
  function skeletonGrid(n) { var s = ''; n = n || 3;
    for (var i = 0; i < n; i++) s += '<div class="adv-card"><div class="adv-skeleton" style="width:55%"></div>' +
      '<div class="adv-skeleton" style="height:18px;width:38%;margin-top:11px"></div></div>';
    return '<div style="display:grid;gap:12px">' + s + '</div>'; }
  function emptyCard(emoji, title, line, cta) {
    return '<div class="adv-card"><div class="adv-empty"><span class="emoji">' + emoji + '</span><h3>' + esc(title) + '</h3>' +
      '<p>' + esc(line) + '</p>' + (cta ? ('<p style="margin-top:14px">' + cta + '</p>') : '') + '</div></div>'; }
  function fmtWindow(a, b) { if (!a) return null;
    try { var da = new Date(a), db = b ? new Date(b) : null, o = { month: 'short', day: 'numeric' }, t = { hour: 'numeric', minute: '2-digit' };
      var s = da.toLocaleDateString(undefined, o) + ', ' + da.toLocaleTimeString(undefined, t);
      if (db) s += '–' + db.toLocaleTimeString(undefined, t); return s; } catch (e) { return null; } }
  function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // ---- live countdown ticker (Watchlist) ----
  var ticker = null;
  function tickTock() { var els = document.querySelectorAll('[data-cd]');
    for (var i = 0; i < els.length; i++) els[i].textContent = '⏳ ' + timeLeft(els[i].getAttribute('data-cd')); }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
  function startTicker() { stopTicker(); tickTock(); ticker = setInterval(tickTock, 1000); }

  // ================= WATCHLIST =================
  var wlData = [], wlSort = 'ending';
  function wlCard(l) {
    var k = classifyKey(l), tone = k === 'winning' ? 'good' : (k === 'outbid' ? 'bad' : 'info'),
        kl = k === 'winning' ? '✓ Winning' : (k === 'outbid' ? 'Outbid' : (l.state === 'open' ? 'Watching' : 'Ended'));
    var open = l.state === 'open';
    var thumb = l.thumbnail_url
      ? '<img src="' + esc(l.thumbnail_url) + '" alt="" style="width:56px;height:56px;border-radius:10px;object-fit:cover;flex:none;background:var(--surface-2)">'
      : '<div style="width:56px;height:56px;border-radius:10px;background:var(--surface-2);display:grid;place-items:center;flex:none;font-size:20px">🔨</div>';
    return '<div class="adv-card" style="display:flex;gap:12px;align-items:center">' + thumb +
      '<div style="min-width:0;flex:1"><div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
        (l.lot_number != null ? ('#' + esc(l.lot_number) + ' ') : '') + esc(l.title || 'Lot') + '</div>' +
      '<div class="adv-row" style="gap:8px;margin-top:6px;flex-wrap:wrap"><span class="adv-chip ' + tone + '">' + kl + '</span>' +
        '<span class="adv-muted" style="font-size:12.5px">Current ' + money(l.current_bid_cents) + '</span>' +
        (open && l.closes_at ? ('<span class="adv-chip warn" data-cd="' + esc(l.closes_at) + '">⏳ ' + esc(timeLeft(l.closes_at)) + '</span>') : '') + '</div></div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;flex:none">' +
        (open ? '<a class="adv-btn primary" style="padding:7px 13px" href="/lot.html?id=' + encodeURIComponent(l.id) + '">Bid</a>'
              : '<a class="adv-btn ghost" style="padding:7px 13px" href="/lot.html?id=' + encodeURIComponent(l.id) + '">View</a>') +
        '<button class="adv-btn ghost" style="padding:7px 13px" data-wl-remove="' + esc(l.id) + '">Remove</button></div></div>';
  }
  function renderWatchlist() {
    var host = document.getElementById('adv-sec-live'); if (!host) return;
    if (!wlData.length) { host.innerHTML = emptyCard('❤️', 'Your watchlist is empty',
      'Tap the heart on any lot to track it here — with live status and countdowns.', '<a class="adv-btn primary" href="/auction.html">Browse auctions</a>'); return; }
    var open = wlData.filter(function (l) { return l.state === 'open'; });
    var ended = wlData.filter(function (l) { return l.state !== 'open'; });
    var sorted = open.slice();
    if (wlSort === 'ending') sorted.sort(function (a, b) { return new Date(a.closes_at || 8.64e15) - new Date(b.closes_at || 8.64e15); });
    else if (wlSort === 'auction') sorted.sort(function (a, b) { return String(a.auction_id).localeCompare(String(b.auction_id)) || ((Number(a.lot_number) || 0) - (Number(b.lot_number) || 0)); });
    else sorted.sort(function (a, b) { return new Date(b.watched_at || 0) - new Date(a.watched_at || 0); });
    var sel = function (v, t) { return '<option value="' + v + '"' + (wlSort === v ? ' selected' : '') + '>' + t + '</option>'; };
    var head = '<div class="adv-row" style="justify-content:space-between;margin:0 2px 14px;flex-wrap:wrap;gap:8px">' +
      '<div class="adv-muted" style="font-size:13.5px">' + open.length + ' active · ' + ended.length + ' ended</div>' +
      '<label class="adv-row" style="gap:6px;font-size:12.5px;color:var(--text-2)">Sort ' +
      '<select id="wl-sort" class="adv-btn ghost" style="padding:7px 10px">' + sel('ending', 'Ending soon') + sel('auction', 'Auction') + sel('added', 'Recently added') + '</select></label></div>';
    host.innerHTML = head + '<div style="display:grid;gap:12px">' + sorted.map(wlCard).join('') +
      (ended.length ? ('<div class="adv-section-title">Ended</div>' + ended.map(wlCard).join('')) : '') + '</div>';
    var s = document.getElementById('wl-sort'); if (s) s.addEventListener('change', function () { wlSort = s.value; renderWatchlist(); });
    host.querySelectorAll('[data-wl-remove]').forEach(function (b) { b.addEventListener('click', function () { wlRemove(b.getAttribute('data-wl-remove')); }); });
    startTicker();
  }
  async function wlRemove(lotId) {
    try { await fetch('/api/watchlist/remove', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: JSON.stringify({ lotId: lotId }) }); } catch (e) {}
    wlData = wlData.filter(function (l) { return l.id !== lotId; });
    renderWatchlist();
  }
  async function loadWatchlist() {
    var r = await apiGet('/api/watchlist').catch(function () { return { ok: false }; });
    if (state.route !== 'watchlist') return;
    wlData = (r.ok && r.body && r.body.data) || [];
    renderWatchlist();
  }

  // ================= PURCHASES =================
  var pickupCache = {};
  function stageTimeline(status) {
    var st = String(status || '').toLowerCase(), paid = st === 'paid';
    var stages = [['Won', true], ['Invoiced', true], ['Paid', paid], ['Pickup', paid], ['Complete', false]];
    return '<div class="adv-row" style="gap:5px;flex-wrap:wrap;margin-top:10px">' + stages.map(function (s, i) {
      return '<span class="adv-chip ' + (s[1] ? 'good' : 'info') + '" style="font-size:10.5px">' + (s[1] ? '✓ ' : '') + s[0] + '</span>' +
        (i < stages.length - 1 ? '<span class="adv-muted" style="font-size:10px">›</span>' : ''); }).join('') + '</div>';
  }
  function purchaseCard(i) {
    var st = String(i.status || '').toLowerCase(), pay = isPayable(i), isPaid = st === 'paid';
    var pill = pay ? '<span class="adv-chip warn">Unpaid</span>' : (isPaid ? '<span class="adv-chip good">Paid</span>' : '<span class="adv-chip info">' + esc(st || 'pending') + '</span>');
    var actions = (pay ? '<a class="adv-btn primary" style="padding:7px 13px" href="/invoices.html">Pay now</a>' : '') +
      '<a class="adv-btn ghost" style="padding:7px 13px" href="/api/invoices/combined/' + encodeURIComponent(i.combined_invoice_id) + '/pdf" target="_blank" rel="noopener">' + (isPaid ? 'Receipt' : 'Invoice') + '</a>';
    return '<div class="adv-card"><div class="adv-row" style="justify-content:space-between;gap:10px">' +
      '<div style="min-width:0"><div style="font-weight:700;font-size:14px">' + esc(i.auction_title || 'Auction') + '</div>' +
      '<div class="adv-muted" style="font-size:12px;margin-top:2px">Invoice ' + esc(i.invoice_number || '') + ' · ' + money(i.total_cents) + '</div></div>' + pill + '</div>' +
      stageTimeline(i.status) +
      '<div class="adv-row" style="gap:8px;margin-top:12px;flex-wrap:wrap">' + actions + '</div>' +
      '<div class="adv-muted" id="pk-' + esc(i.auction_id) + '" style="font-size:12px;margin-top:10px"></div></div>';
  }
  async function loadPurchases() {
    var r = await apiGet('/api/invoices/mine/combined').catch(function () { return { ok: false }; });
    if (state.route !== 'purchases') return;
    var host = document.getElementById('adv-sec-live'); if (!host) return;
    var inv = (r.ok && r.body && r.body.invoices) || [];
    if (!inv.length) { host.innerHTML = emptyCard('📦', 'No purchases yet',
      "When you win a lot, your invoice, payment, and pickup details show up here.", '<a class="adv-btn primary" href="/auction.html">Browse auctions</a>'); return; }
    var payable = inv.filter(isPayable), paid = inv.filter(function (i) { return String(i.status || '').toLowerCase() === 'paid'; });
    var other = inv.filter(function (i) { return !isPayable(i) && String(i.status || '').toLowerCase() !== 'paid'; });
    var head = '<div class="adv-muted" style="margin:0 2px 14px;font-size:13.5px">' +
      (payable.length ? ('You have ' + payable.length + ' purchase' + (payable.length > 1 ? 's' : '') + ' awaiting payment.') : 'All your purchases are paid. Nicely done.') + '</div>';
    var sec = function (t, list) { return list.length ? ('<div class="adv-section-title">' + t + '</div><div style="display:grid;gap:12px">' + list.map(purchaseCard).join('') + '</div>') : ''; };
    host.innerHTML = head + sec('Action needed', payable) + sec('Processing', other) + sec('Completed', paid);
    enrichPickups(inv);
  }
  async function enrichPickups(inv) {
    var ids = {}; inv.forEach(function (i) { if (i.auction_id) ids[i.auction_id] = true; });
    await Promise.all(Object.keys(ids).slice(0, 10).map(function (aid) {
      return (pickupCache[aid] ? Promise.resolve({ body: pickupCache[aid] }) : apiGet('/api/auctions/' + aid + '/summary'))
        .then(function (s) {
          if (s.body && s.body.data) pickupCache[aid] = s.body;
          var d = s.body && s.body.data; if (!d) return;
          var el = document.getElementById('pk-' + aid); if (!el) return;
          var when = fmtWindow(d.pickup_window_start, d.pickup_window_end);
          var where = [d.pickup_street, [d.city, d.address_state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
          var paidInv = inv.some(function (i) { return i.auction_id === aid && String(i.status || '').toLowerCase() === 'paid'; });
          var bits = [];
          if (when) bits.push('📅 Pickup ' + when);
          if (where) bits.push('📍 ' + where + (paidInv ? '' : ' (exact address after payment)'));
          el.innerHTML = bits.map(esc).join(' &nbsp;·&nbsp; ');
        }).catch(function () {});
    }));
  }

  // ================= SELLERS =================
  function typeLabel(t) { t = String(t || '').toLowerCase();
    var m = { auction_house: 'Auction house', estate_sale_company: 'Estate sale company', professional_liquidator: 'Professional liquidator', business: 'Business seller', private: 'Private seller', other: 'Seller' };
    return m[t] || 'Seller'; }
  function sellerCardShell(f) {
    var n = Number(f.active_auction_count) || 0;
    return '<div class="adv-card"><div class="adv-row" style="justify-content:space-between;gap:10px">' +
      '<div style="min-width:0"><div style="font-weight:700;font-size:14px" data-sname="' + esc(f.seller_id) + '">' + esc(typeLabel(f.seller_type)) + '</div>' +
      '<div class="adv-muted" style="font-size:12px;margin-top:2px">' + esc(typeLabel(f.seller_type)) + ' · ' + n + ' active auction' + (n === 1 ? '' : 's') + '</div></div>' +
      '<button class="adv-btn ghost" style="padding:7px 13px;flex:none" data-unfollow="' + esc(f.seller_id) + '">Unfollow</button></div>' +
      '<div data-sauctions="' + esc(f.seller_id) + '"></div></div>';
  }
  async function loadSellers() {
    var r = await apiGet('/api/sellers/following').catch(function () { return { ok: false }; });
    if (state.route !== 'sellers') return;
    var host = document.getElementById('adv-sec-live'); if (!host) return;
    var follow = (r.ok && r.body && r.body.data) || [];
    if (!follow.length) { host.innerHTML = emptyCard('🏪', "You're not following any sellers yet",
      'Follow sellers to catch their new auctions and keep their sales close.', '<a class="adv-btn primary" href="/index.html">Explore the marketplace</a>'); return; }
    host.innerHTML = '<div class="adv-muted" style="margin:0 2px 14px;font-size:13.5px">Following ' + follow.length + ' seller' + (follow.length > 1 ? 's' : '') + '.</div>' +
      '<div style="display:grid;gap:12px">' + follow.map(sellerCardShell).join('') + '</div>';
    host.querySelectorAll('[data-unfollow]').forEach(function (b) { b.addEventListener('click', function () { unfollow(b.getAttribute('data-unfollow')); }); });
    follow.forEach(function (f) { if (Number(f.active_auction_count) > 0) enrichSeller(f.seller_id); });
  }
  async function enrichSeller(sellerId) {
    try {
      var r = await apiGet('/api/public/auctions?seller_id=' + encodeURIComponent(sellerId));
      var d = (r.body && r.body.data) || [];
      var nm = d.length && d[0].seller_display_name;
      if (nm) { var nEl = document.querySelector('[data-sname="' + cssq(sellerId) + '"]'); if (nEl) nEl.textContent = nm; }
      var host = document.querySelector('[data-sauctions="' + cssq(sellerId) + '"]'); if (!host || !d.length) return;
      host.innerHTML = '<div style="margin-top:8px">' + d.slice(0, 4).map(function (a) {
        var live = a.state === 'active';
        return '<div class="adv-row" style="justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid var(--line)">' +
          '<div style="min-width:0"><div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(a.title || 'Auction') + '</div>' +
          '<div class="adv-muted" style="font-size:11.5px">' + (live ? 'Live now' : ('Starts ' + (fmtWindow(a.start_time) || 'soon'))) + ' · ' + (a.lot_count || 0) + ' lots</div></div>' +
          '<a class="adv-btn ' + (live ? 'primary' : 'ghost') + '" style="padding:6px 12px;flex:none" href="/auction-view.html?id=' + encodeURIComponent(a.id) + '">' + (live ? 'Bid' : 'View') + '</a></div>'; }).join('') + '</div>';
    } catch (e) {}
  }
  async function unfollow(sellerId) {
    try { await fetch('/api/sellers/' + encodeURIComponent(sellerId) + '/follow', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token() } }); } catch (e) {}
    var card = document.querySelector('[data-unfollow="' + cssq(sellerId) + '"]');
    var box = card && card.closest ? card.closest('.adv-card') : null; if (box) box.remove();
  }

  // ================= ACCOUNT =================
  function acField(label, id, val, type) {
    return '<div style="margin-bottom:12px"><div style="font-size:12px;color:var(--text-2);font-weight:600;margin-bottom:4px">' + esc(label) + '</div>' +
      '<input class="adv-inp" id="' + id + '" type="' + type + '" value="' + esc(val) + '"></div>'; }
  function acLink(emoji, title, sub, href) {
    return '<a href="' + href + '" style="text-decoration:none;color:inherit"><div class="adv-row" style="justify-content:space-between;padding:11px 0;border-top:1px solid var(--line)">' +
      '<div class="adv-row" style="gap:11px"><span style="font-size:17px">' + emoji + '</span><div><div style="font-weight:600;font-size:13.5px">' + esc(title) + '</div>' +
      '<div class="adv-muted" style="font-size:12px">' + esc(sub) + '</div></div></div><span class="adv-muted">›</span></div></a>'; }
  function loadAccount() {
    var host = document.getElementById('adv-sec-live'); if (!host) return;
    var u = state.user || {};
    host.innerHTML =
      '<div class="adv-muted" style="margin:0 2px 14px;font-size:13.5px">Manage your Advantage profile and preferences.</div>' +
      '<div style="display:grid;gap:12px;max-width:560px">' +
        '<div class="adv-card"><div style="font-weight:800;font-size:14px;margin-bottom:12px">Profile</div>' +
          acField('Name', 'ac-name', u.full_name || '', 'text') + acField('Phone', 'ac-phone', u.phone || '', 'tel') +
          '<div style="margin-bottom:6px"><div style="font-size:12px;color:var(--text-2);font-weight:600;margin-bottom:4px">Email</div>' +
            '<div class="adv-row" style="gap:8px"><input class="adv-inp" value="' + esc(u.email || '') + '" disabled>' +
            '<span class="adv-chip info" style="flex:none">account-managed</span></div></div>' +
          '<div class="adv-row" style="gap:10px;margin-top:12px"><button class="adv-btn primary" id="ac-save">Save changes</button>' +
            '<span id="ac-msg" class="adv-muted" style="font-size:12.5px"></span></div></div>' +
        '<div class="adv-card"><div style="font-weight:800;font-size:14px;margin-bottom:2px">Account &amp; security</div>' +
          acLink('💳', 'Payment methods', 'Add or update your saved card', '/billing.html') +
          acLink('🔒', 'Password', 'Reset your password', '/forgot-password.html') +
          '<div class="adv-row" style="justify-content:space-between;padding:11px 0;border-top:1px solid var(--line)"><div class="adv-row" style="gap:11px"><span style="font-size:17px">🔔</span><div><div style="font-weight:600;font-size:13.5px">Notification preferences</div><div class="adv-muted" style="font-size:12px">Choose what updates you receive</div></div></div><span class="adv-chip info">coming soon</span></div></div>' +
        '<div class="adv-card"><button class="adv-btn ghost" id="ac-logout" style="width:100%;justify-content:center">Log out</button></div></div>';
    var sv = document.getElementById('ac-save'); if (sv) sv.addEventListener('click', accountSave);
    var lo = document.getElementById('ac-logout'); if (lo) lo.addEventListener('click', function () { try { localStorage.removeItem('token'); } catch (e) {} location.href = '/login.html'; });
  }
  async function accountSave() {
    var nameEl = document.getElementById('ac-name'), phoneEl = document.getElementById('ac-phone'), msg = document.getElementById('ac-msg');
    var name = nameEl ? nameEl.value : '', phone = phoneEl ? phoneEl.value : '';
    if (msg) msg.textContent = 'Saving…';
    try {
      var res = await fetch('/api/auth/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: JSON.stringify({ full_name: name, phone: phone }) });
      var b = null; try { b = await res.json(); } catch (e) {}
      if (res.ok) { state.user.full_name = name; state.user.phone = phone; if (msg) msg.textContent = '✓ Saved';
        var un = document.querySelector('.adv-user-name'); if (un) un.textContent = name || state.user.email; }
      else if (msg) msg.textContent = (b && (b.message || b.error)) || 'Could not save';
    } catch (e) { if (msg) msg.textContent = 'Could not save'; }
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
      case 'auctions':  return stub('🔨', 'Auctions', "Browse live auctions, ending soon, and the ones you've bid in.") +
                          '<div style="margin-top:-6px"><a class="adv-btn primary" href="/auction.html">Browse all auctions</a></div>';
      case 'watchlist':
      case 'purchases':
      case 'sellers':   return '<div id="adv-sec-live">' + skeletonGrid() + '</div>';
      case 'sell':      return (state.isSeller && state.user.role !== 'admin') ? ('<div id="adv-sec-live">' + skeletonGrid() + '</div>') : sellBody();
      case 'analytics': return (state.user.role === 'admin') ? stub('📊', 'Analytics', 'Platform-wide analytics arrive with the admin overview in Phase 6.') : ('<div id="adv-sec-live">' + skeletonGrid() + '</div>');
      case 'messages':  return '<div class="adv-card"><div class="adv-row" style="justify-content:space-between;margin-bottom:6px">' +
                          '<div style="font-weight:800">Updates &amp; Notifications</div>' +
                          '<span class="adv-chip accent">Conversations — coming later</span></div>' +
                          '<div class="adv-empty"><span class="emoji">💬</span><h3>Your updates inbox</h3>' +
                          '<p>Outbid alerts, payment reminders, pickup notices, new auctions from sellers you follow, and account updates — all in one place. This is an updates &amp; notifications inbox, not two-way messaging (that comes later). Wires to your notifications in Phase 5.</p></div></div>';
      case 'account':   return '<div id="adv-sec-live">' + skeletonGrid() + '</div>';
      default:          return homeBody();
    }
  }

  function setRoute(route) {
    var item = Nav.byId(route) && Nav.visibleNavFor(navCtx()).some(function (i) { return i.id === route; }) ? route : 'home';
    state.route = item;
    stopTicker();
    var main = document.getElementById('adv-main'); if (main) main.innerHTML = sectionBody(item);
    if (item === 'home' && document.getElementById('adv-home-live')) {
      if (state.isSeller && state.user.role !== 'admin') loadSellerHome(); else loadBuyerHome();
    }
    if (document.getElementById('adv-sec-live')) {
      if (item === 'watchlist') loadWatchlist();
      else if (item === 'purchases') loadPurchases();
      else if (item === 'sellers') loadSellers();
      else if (item === 'account') loadAccount();
      else if (item === 'sell') loadSellWorkspace();
      else if (item === 'analytics') loadSellerAnalytics();
    }
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
