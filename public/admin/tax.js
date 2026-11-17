/* Admin: Sales Tax dashboard (public/admin/tax.html; API /api/admin/tax). Built with DOM calls; every value is set as
   text. Nothing on this page registers, files or pays: it records what a person did and reports from the tax ledger. */
(function () {
  'use strict';
  var token = null; try { token = localStorage.getItem('token'); } catch (e) { /* no storage */ }
  var LOGIN = '/login.html?next=' + encodeURIComponent(location.pathname + location.hash);
  if (!token) { location.href = LOGIN; return; }
  var API = '/api/admin/tax';

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
  function api(method, url, body) {
    return fetch(url, { method: method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 401) { location.href = LOGIN; throw new Error('auth'); }
        return r.json().catch(function () { return { success: false, message: 'The server did not answer as expected.' }; });
      });
  }
  function $(id) { return document.getElementById(id); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function why(r, fallback) { return (r && (r.message || r.error)) || fallback; }
  function say(t, ok) { var m = $('status'); m.textContent = t || ''; m.style.color = ok ? '#166534' : '#991b1b'; }
  function netErr(e) { if (!e || e.message !== 'auth') say('Network error. Please try again.'); }
  function money(c) {
    var v = Math.round(Number(c) || 0); var a = Math.abs(v);
    return (v < 0 ? '-' : '') + '$' + Math.floor(a / 100).toLocaleString('en-US') + '.' + String(a % 100).padStart(2, '0');
  }
  // Dollars typed by a person to whole cents. Returns null for an empty field and NaN for something that is not an amount.
  function cents(str) {
    var s = String(str == null ? '' : str).replace(/[$,\s]/g, '');
    if (!s) return null;
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN;
    var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
    var parts = s.split('.');
    var v = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0, 2));
    return neg ? -v : v;
  }
  function badAmount(v) { return typeof v === 'number' && isNaN(v); }
  function button(label, cls, fn) { var b = el('button', label, 'btn btn-sm ' + (cls || '')); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function badge(text, cls) { return el('span', text, 'badge ' + (cls || '')); }
  function td(text, cls) { return el('td', text == null ? '' : String(text), cls); }
  function num(c) { return td(money(c), 'num'); }
  function empty(tb, cols, text) { var tr = el('tr'); var c = el('td', text, 'small'); c.colSpan = cols; tr.appendChild(c); tb.appendChild(tr); }
  function when(v) { return v ? new Date(v).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET' : ''; }
  function fillStates(sel, states, keepFirst) {
    if (sel.options.length > (keepFirst ? 1 : 0)) return;
    states.forEach(function (s) { var o = el('option', s); o.value = s; sel.appendChild(o); });
  }
  function qs(obj) {
    var out = [];
    Object.keys(obj).forEach(function (k) { if (obj[k] != null && obj[k] !== '') out.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])); });
    return out.length ? '?' + out.join('&') : '';
  }
  // A CSV is fetched with the session header and saved through a temporary link (the page is same-origin).
  function download(url, fallbackName) {
    say('Preparing the file...', true);
    fetch(url, { headers: { Authorization: 'Bearer ' + token } }).then(function (r) {
      if (r.status === 401) { location.href = LOGIN; throw new Error('auth'); }
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(why(j, 'The file could not be prepared.')); });
      var name = fallbackName; var m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || ''); if (m) name = m[1];
      return r.blob().then(function (blob) {
        var a = document.createElement('a'); var href = URL.createObjectURL(blob);
        a.href = href; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(href); }, 2000);
        say('Downloaded ' + name + '.', true);
      });
    }).catch(function (e) { if (e.message !== 'auth') say(e.message || 'Network error.'); });
  }
  function act(promise, okText, after) {
    return promise.then(function (r) {
      if (!r.success) { say(why(r, 'Not done.')); return r; }
      say(okText, true); if (after) after(r); return r;
    }).catch(netErr);
  }

  var STATES = [];
  var CHANNEL = { auction: 'Auction', marketplace: 'Marketplace', seller_website: 'Seller website', platform: 'Advantage.Bid' };
  var REMITTER = { platform: 'Advantage.Bid remits', seller_direct: 'Seller is responsible', none: 'No tax due', unconfigured: 'No rule', exception: 'Exception', seller: 'Paid to seller (retired)' };
  var TYPE = { sale: 'Sale', refund: 'Refund', dispute: 'Dispute', remittance: 'Remittance', reserve_transfer: 'Tax account transfer', adjustment: 'Correction' };
  var RULE = { platform: 'Advantage.Bid collects and remits', seller_direct: 'Not collected; seller is responsible', seller: 'Retired rule' };

  // ── tabs ───────────────────────────────────────────────────────────────────────────────────────────────────────
  var TABS = ['overview', 'ledger', 'registrations', 'rules', 'codes', 'nexus', 'exceptions', 'sellers'];
  var loaded = {};
  var LOADERS = {};
  function show(tab, fromHash) {
    if (TABS.indexOf(tab) < 0) tab = 'overview';
    TABS.forEach(function (t) { $('panel-' + t).hidden = t !== tab; });
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === tab ? 'true' : 'false'); });
    if (!fromHash) { try { history.replaceState(null, '', '#' + tab); } catch (e) { /* no history */ } }
    if (!loaded[tab] && LOADERS[tab]) { loaded[tab] = true; LOADERS[tab](); }
  }
  Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (b) { b.addEventListener('click', function () { say(''); show(b.getAttribute('data-tab')); }); });
  window.addEventListener('hashchange', function () { show(location.hash.replace('#', ''), true); });

  // ── overview ───────────────────────────────────────────────────────────────────────────────────────────────────
  var settings = { is_owner: false, auction_enforcement: 'report', reserve_guard: true };
  var overviewData = null;

  function stat(label, value, note) { var s = el('div', null, 'stat'); s.appendChild(el('div', label, 'k')); s.appendChild(el('div', value, 'v')); if (note) s.appendChild(el('div', note, 'n')); return s; }
  function ruleCell(rule) {
    var c = el('td');
    if (!rule) { c.appendChild(badge('No rule', 'b-bad')); return c; }
    c.appendChild(badge(RULE[rule.remitter] || rule.remitter, rule.retired ? 'b-warn' : 'b-ok'));
    if (rule.retired) c.appendChild(el('div', 'Treated as no rule for new sales', 'small'));
    else if (!rule.in_effect) c.appendChild(el('div', 'Starts ' + rule.effective_from, 'small'));
    return c;
  }
  function regCell(reg) {
    var c = el('td');
    if (!reg) { c.appendChild(el('span', 'None recorded', 'small')); return c; }
    c.appendChild(badge(reg.status === 'active' ? 'Active' : reg.status === 'pending' ? 'Pending' : 'Closed', reg.status === 'active' ? 'b-ok' : reg.status === 'pending' ? 'b-warn' : ''));
    if (reg.filing_frequency) c.appendChild(el('div', 'Files ' + reg.filing_frequency, 'small'));
    return c;
  }
  function filingCell(f) {
    var c = el('td');
    if (!f) { c.appendChild(el('span', 'No filing row', 'small')); return c; }
    c.appendChild(badge(f.status === 'paid' ? 'Paid' : f.status === 'filed' ? 'Filed' : 'Open', f.status === 'open' ? 'b-warn' : 'b-ok'));
    c.appendChild(el('div', f.due_date ? 'Due ' + f.due_date : 'No due date entered', 'small'));
    return c;
  }
  function renderOverview(d) {
    overviewData = d;
    var sel = $('period'); clear(sel);
    d.periods.forEach(function (p) { var o = el('option', p + (p === d.current_period ? ' (current)' : '')); o.value = p; sel.appendChild(o); });
    sel.value = d.period;

    var st = clear($('ov-stats'));
    st.appendChild(stat('Outstanding sales tax', money(d.totals.outstanding_cents), 'All states, all time: collected to remit, less remitted'));
    st.appendChild(stat('Net tax to remit, ' + d.period, money(d.totals.platform_net_tax_cents), 'Tax collected ' + money(d.totals.tax_collected_cents) + ', refunded ' + money(d.totals.tax_refunded_cents)));
    st.appendChild(stat('Gross sales, ' + d.period, money(d.totals.gross_cents), d.totals.sale_count + ' sale(s); taxable ' + money(d.totals.taxable_cents)));
    st.appendChild(stat('Must stay on hand', money(d.reserve.requiredOnHand), 'Held in the tax account: ' + money(d.reserve.heldOutside)));
    st.appendChild(stat('Auction safeguard', d.enforcement === 'enforce' ? 'Enforcing' : 'Report only', d.enforcement === 'enforce' ? 'Payments without a rule are held' : 'Payments proceed and are reported'));
    st.appendChild(stat('Open alerts', String(d.open_alerts.total), d.open_alerts.critical + ' critical, ' + d.open_alerts.warning + ' warning'));
    st.appendChild(stat('Sales without a rule, ' + d.period, String(d.unconfigured_sales), d.exception_sales + ' under an exception'));

    var tb = clear($('ov-rows'));
    if (!d.states.length) empty(tb, 11, 'No ledger entries, rules or registrations yet.');
    d.states.forEach(function (s) {
      var tr = el('tr'); tr.setAttribute('data-state', s.state || 'none');
      tr.appendChild(td(s.state || 'Unknown state'));
      [['gross_cents', s.gross_cents], ['taxable_cents', s.taxable_cents], ['tax_collected_cents', s.tax_collected_cents], ['tax_refunded_cents', s.tax_refunded_cents],
        ['platform_net_tax_cents', s.platform_net_tax_cents], ['all_time_remitted_cents', s.all_time_remitted_cents], ['outstanding_cents', s.outstanding_cents]]
        .forEach(function (p) { var c = num(p[1]); c.setAttribute('data-k', p[0]); tr.appendChild(c); });
      tr.appendChild(ruleCell(s.rule)); tr.appendChild(regCell(s.registration)); tr.appendChild(filingCell(s.filing));
      tb.appendChild(tr);
    });
    var tf = clear($('ov-totals'));
    var tr = el('tr'); tr.appendChild(td('All states'));
    [['gross_cents', d.totals.gross_cents], ['taxable_cents', d.totals.taxable_cents], ['tax_collected_cents', d.totals.tax_collected_cents], ['tax_refunded_cents', d.totals.tax_refunded_cents],
      ['platform_net_tax_cents', d.totals.platform_net_tax_cents], ['all_time_remitted_cents', d.totals.all_time_remitted_cents], ['outstanding_cents', d.totals.outstanding_cents]]
      .forEach(function (p) { var c = num(p[1]); c.setAttribute('data-k', p[0]); tr.appendChild(c); });
    var rest = td(''); rest.colSpan = 3; tr.appendChild(rest); tf.appendChild(tr);

    var ch = clear($('ov-channels'));
    var keys = Object.keys(d.totals.by_channel).sort();
    if (!keys.length) empty(ch, 5, 'No sales this month.');
    keys.forEach(function (k) {
      var v = d.totals.by_channel[k]; var r = el('tr');
      r.appendChild(td(CHANNEL[k] || k)); r.appendChild(td(String(v.sale_count), 'num')); r.appendChild(num(v.gross_cents)); r.appendChild(num(v.taxable_cents)); r.appendChild(num(v.net_tax_cents));
      ch.appendChild(r);
    });

    $('reserve-text').textContent = 'Collected to remit (all time): ' + money(d.reserve.collected) + '. Remitted: ' + money(d.reserve.remitted) + '. Outstanding: ' + money(d.reserve.outstanding)
      + '. Held in the tax bank account: ' + money(d.reserve.heldOutside) + '. Must stay available in the payment account: ' + money(d.reserve.requiredOnHand) + '.';

    var rules = clear($('rule-rows'));
    var withRule = d.states.filter(function (s) { return s.rule || s.registration; });
    if (!withRule.length) empty(rules, 5, 'No rules or registrations yet.');
    withRule.forEach(function (s) {
      var r = el('tr'); r.appendChild(td(s.state)); r.appendChild(ruleCell(s.rule)); r.appendChild(td(s.rule ? s.rule.effective_from : ''));
      r.appendChild(td(s.rule ? (s.rule.last_verified_at || 'Never') : '')); r.appendChild(regCell(s.registration)); rules.appendChild(r);
    });
    renderRecon(d.reconciliation);
    renderSettings();
  }
  function loadOverview(period) {
    return api('GET', API + '/overview' + qs({ period: period || '' })).then(function (r) {
      if (!r.success) { say(why(r, 'Could not load the overview.')); return; }
      renderOverview(r.data);
    }).catch(netErr);
  }
  function renderSettings() {
    var enforce = settings.auction_enforcement === 'enforce';
    $('mode-text').textContent = (enforce
      ? 'Auction safeguard: ENFORCING. An auction in a state without a usable rule cannot be published, and its payments are held for an administrator.'
      : 'Auction safeguard: REPORT ONLY. Auction payments in a state without a usable rule proceed as before, and each one raises an alert.')
      + ' Payout safeguard: ' + (settings.reserve_guard ? 'ON. A seller payout is refused when it would spend money held for sales tax.' : 'OFF. Seller payouts are not checked against sales tax owed.');
    $('owner-note').textContent = settings.is_owner ? 'You are signed in as the platform owner and can change these settings.' : 'Only the platform owner can change these settings.';
    $('mode-enforce').hidden = enforce; $('mode-report').hidden = !enforce;
    $('guard-toggle').textContent = settings.reserve_guard ? 'Turn Payout Safeguard Off' : 'Turn Payout Safeguard On';
    ['mode-enforce', 'mode-report', 'guard-toggle'].forEach(function (id) { $(id).disabled = !settings.is_owner; });
  }
  function loadSettings() {
    return api('GET', API + '/settings').then(function (r) { if (r.success) { settings = r.data; renderSettings(); } }).catch(netErr);
  }
  function putSettings(body, okText) {
    return api('PUT', API + '/settings', body).then(function (r) {
      if (r.success) { say(okText, true); return loadSettings().then(function () { return loadOverview($('period').value); }); }
      if (r.code === 'UNCONFIGURED_AUCTIONS' && r.data && r.data.blocking) {
        var names = r.data.blocking.slice(0, 8).map(function (a) { return (a.title || 'Untitled auction') + ' (' + a.pickup_state + ')'; }).join('\n');
        if (confirm(r.message + '\n\n' + names + (r.data.blocking.length > 8 ? '\n(and more: see the auction audit)' : '') + '\n\nTurn enforcement on anyway? Payments for these auctions will be held.')) {
          return putSettings({ auction_enforcement: 'enforce', acknowledge_unconfigured: true }, okText);
        }
        say('Enforcement was not turned on.'); renderAudit(null); return null;
      }
      say(why(r, 'The setting was not changed.')); return null;
    }).catch(netErr);
  }
  function renderAudit(done) {
    api('GET', API + '/auction-audit').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load the auction audit.')); return; }
      $('audit-box').hidden = false;
      var a = r.data;
      $('audit-summary').textContent = a.auctions.length + ' auction(s) not yet finished. ' + a.blocking.length + ' published or active in a state without a usable rule'
        + (a.states_without_rule.length ? ' (states without a rule: ' + a.states_without_rule.join(', ') + ')' : '') + '. ' + a.unknown_state + ' with no pickup state yet.';
      var tb = clear($('audit-rows'));
      if (!a.auctions.length) empty(tb, 7, 'No auctions to review.');
      a.auctions.forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(td(x.title || 'Untitled auction')); tr.appendChild(td(x.seller_name || ''));
        tr.appendChild(td(x.auction_state)); tr.appendChild(td(x.pickup_state || 'Not set'));
        var c = el('td'); c.appendChild(x.rule_usable ? badge(RULE[x.rule] || x.rule, 'b-ok') : badge(x.pickup_state ? (x.rule === 'seller' ? 'Retired rule' : 'No usable rule') : 'State not set', x.live && x.pickup_state ? 'b-bad' : 'b-warn'));
        tr.appendChild(c); tr.appendChild(td(when(x.bidding_starts_at))); tr.appendChild(td(when(x.bidding_ends_at)));
        tb.appendChild(tr);
      });
      if (done) done();
    }).catch(netErr);
  }

  function alertNode(a, open) {
    var box = el('div', null, 'alert ' + a.severity);
    box.appendChild(el('div', a.message));
    box.appendChild(el('div', (open ? 'First seen ' + when(a.created_at) + '; last seen ' + when(a.last_seen_at) : 'Resolved ' + when(a.resolved_at) + ': ' + (a.resolution || '')), 'small'));
    if (open) box.appendChild(button('Resolve', 'btn-mut', function () {
      var note = prompt('How was this resolved? (recorded with your name)'); if (!note) return;
      act(api('POST', API + '/alerts/' + a.id + '/resolve', { note: note }), 'Alert resolved.', function () { loadAlerts(); loadOverview($('period').value); });
    }));
    return box;
  }
  function loadAlerts() {
    return api('GET', API + '/alerts').then(function (r) {
      if (!r.success) return;
      var list = clear($('alert-list')); var holds = clear($('hold-list'));
      var general = r.data.filter(function (a) { return a.alert_type !== 'payment_hold' && a.alert_type !== 'auction_untaxed'; });
      var held = r.data.filter(function (a) { return a.alert_type === 'payment_hold' || a.alert_type === 'auction_untaxed'; });
      if (!r.data.length) list.appendChild(el('div', 'No open alerts.', 'small'));
      r.data.forEach(function (a) { list.appendChild(alertNode(a, true)); });
      if (!held.length) holds.appendChild(el('div', 'No auction payments are on hold, and no auction is being paid without sales tax.', 'small'));
      held.forEach(function (a) { holds.appendChild(alertNode(a, true)); });
      return general;
    }).catch(netErr);
  }
  function renderRecon(run) {
    var t = $('recon-text'); var c = clear($('recon-checks'));
    if (!run) { t.textContent = 'No reconciliation has run yet.'; return; }
    var label = run.status === 'clean' ? 'Clean: every record agrees.' : run.status === 'mismatches' ? 'Differences found. See the open alerts.' : run.status === 'failed' ? 'The last run did not finish.' : 'Running.';
    t.textContent = 'Last run ' + when(run.finished_at || run.started_at) + '. ' + label;
    var checks = run.summary && Array.isArray(run.summary.checks) ? run.summary.checks : [];
    checks.forEach(function (k) { c.appendChild(el('div', (k.ok ? 'OK' : 'CHECK') + ' · ' + (k.note || k.name) + (k.ok ? '' : ' (' + k.count + ')'))); });
  }

  LOADERS.overview = function () { loadSettings(); loadOverview(); loadAlerts(); };
  $('period').addEventListener('change', function () { loadOverview($('period').value); });
  $('ov-refresh').addEventListener('click', function () { say(''); loadSettings(); loadOverview($('period').value); loadAlerts(); });
  $('ov-csv').addEventListener('click', function () { download(API + '/state-summary.csv', 'sales-tax-by-state.csv'); });
  $('mode-enforce').addEventListener('click', function () {
    if (!confirm('Turn auction enforcement on? An auction in a state without a usable sales tax rule can no longer be published, and its payments are held.')) return;
    putSettings({ auction_enforcement: 'enforce' }, 'Enforcement is on.');
  });
  $('mode-report').addEventListener('click', function () {
    if (!confirm('Return to report only? Auction payments in a state without a rule will proceed and be reported.')) return;
    putSettings({ auction_enforcement: 'report' }, 'The safeguard now reports only.');
  });
  $('guard-toggle').addEventListener('click', function () {
    var next = !settings.reserve_guard;
    if (!confirm(next ? 'Turn the payout safeguard on?' : 'Turn the payout safeguard off? Seller payouts will no longer be checked against sales tax owed.')) return;
    putSettings({ reserve_guard: next }, next ? 'The payout safeguard is on.' : 'The payout safeguard is off.');
  });
  $('audit-load').addEventListener('click', function () { renderAudit(); });
  $('alerts-resolved').addEventListener('click', function () {
    api('GET', API + '/alerts?status=resolved').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load.')); return; }
      var box = clear($('alert-resolved-list')); box.hidden = false;
      if (!r.data.length) box.appendChild(el('div', 'No resolved alerts.', 'small'));
      r.data.forEach(function (a) { box.appendChild(alertNode(a, false)); });
    }).catch(netErr);
  });
  $('recon-run').addEventListener('click', function () {
    $('recon-run').disabled = true; say('Reconciling...', true);
    api('POST', API + '/reconciliation/run').then(function (r) {
      $('recon-run').disabled = false;
      if (!r.success) { say(why(r, 'The reconciliation did not run.')); return; }
      say('Reconciliation finished.', true); renderRecon(r.data); loadAlerts(); loadOverview($('period').value);
    }).catch(function (e) { $('recon-run').disabled = false; netErr(e); });
  });
  $('recon-history').addEventListener('click', function () {
    api('GET', API + '/reconciliation').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load.')); return; }
      var box = clear($('recon-history-list'));
      if (!r.data.length) box.appendChild(el('div', 'No runs yet.'));
      r.data.forEach(function (x) { box.appendChild(el('div', when(x.finished_at || x.started_at) + ' · ' + x.status)); });
    }).catch(netErr);
  });
  $('rt-save').addEventListener('click', function () {
    var amt = cents($('rt-amount').value);
    if (amt == null || badAmount(amt) || amt === 0) { say('Enter the amount moved, in dollars.'); return; }
    if (!confirm('Record ' + money(amt) + ' as ' + (amt > 0 ? 'moved to' : 'moved back from') + ' the tax bank account? This records a transfer you already made at the bank.')) return;
    act(api('POST', API + '/reserve/transfers', { amount_cents: amt, moved_on: $('rt-date').value || undefined, reference: $('rt-ref').value, note: $('rt-note').value }),
      'Transfer recorded.', function () { ['rt-amount', 'rt-date', 'rt-ref', 'rt-note'].forEach(function (i) { $(i).value = ''; }); loadOverview($('period').value); });
  });

  // ── ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────
  var ledgerPage = { offset: 0, limit: 100, total: 0 };
  function ledgerFilters() {
    return { state: $('lf-state').value, period: $('lf-period').value, channel: $('lf-channel').value, remitter: $('lf-remitter').value,
      entry_type: $('lf-type').value, seller_profile_id: $('lf-seller').value.trim(), source_id: $('lf-source').value.trim() };
  }
  function loadLedger() {
    var f = ledgerFilters(); f.limit = ledgerPage.limit; f.offset = ledgerPage.offset;
    return api('GET', API + '/ledger' + qs(f)).then(function (r) {
      if (!r.success) { say(why(r, 'Could not load the ledger.')); return; }
      ledgerPage.total = r.data.total;
      var tb = clear($('lf-rows'));
      if (!r.data.rows.length) empty(tb, 13, 'No ledger entries match.');
      r.data.rows.forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(td(x.id)); tr.appendChild(td(when(x.occurred_at))); tr.appendChild(td(TYPE[x.entry_type] || x.entry_type)); tr.appendChild(td(CHANNEL[x.channel] || x.channel));
        tr.appendChild(td(x.state || '')); tr.appendChild(td(x.remitter ? (REMITTER[x.remitter] || x.remitter) : ''));
        tr.appendChild(td(x.seller_name || (x.seller_profile_id ? 'Seller ' + String(x.seller_profile_id).slice(0, 8) : '')));
        tr.appendChild(num(x.gross_cents)); tr.appendChild(num(x.taxable_cents)); tr.appendChild(num(x.exempt_cents)); tr.appendChild(num(x.tax_collected_cents));
        tr.appendChild(num(x.entry_type === 'reserve_transfer' ? x.tax_reserved_cents : x.tax_remitted_cents));
        var src = el('td');
        if (x.source_id) src.appendChild(el('div', (x.source_type === 'auction_payment' ? 'Auction payment ' : x.source_type === 'marketplace_order' ? 'Order ' : x.source_type === 'filing' ? 'Filing ' : '') + x.source_id, 'small'));
        if (x.tax_basis) src.appendChild(el('div', 'Basis: ' + x.tax_basis, 'small'));
        if (x.note) src.appendChild(el('div', x.note, 'small'));
        tr.appendChild(src); tb.appendChild(tr);
      });
      var from = r.data.total ? r.data.offset + 1 : 0;
      $('lf-count').textContent = from + ' to ' + (r.data.offset + r.data.rows.length) + ' of ' + r.data.total + ' entries';
      $('lf-prev').disabled = r.data.offset <= 0; $('lf-next').disabled = r.data.offset + r.data.rows.length >= r.data.total;
    }).catch(netErr);
  }
  LOADERS.ledger = function () { withStates(function () { loadLedger(); }); };
  $('lf-apply').addEventListener('click', function () { ledgerPage.offset = 0; loadLedger(); });
  $('lf-clear').addEventListener('click', function () {
    ['lf-state', 'lf-period', 'lf-channel', 'lf-remitter', 'lf-type', 'lf-seller', 'lf-source'].forEach(function (i) { $(i).value = ''; });
    ledgerPage.offset = 0; loadLedger();
  });
  $('lf-prev').addEventListener('click', function () { ledgerPage.offset = Math.max(0, ledgerPage.offset - ledgerPage.limit); loadLedger(); });
  $('lf-next').addEventListener('click', function () { ledgerPage.offset += ledgerPage.limit; loadLedger(); });
  $('lf-csv').addEventListener('click', function () { download(API + '/ledger.csv' + qs(ledgerFilters()), 'sales-tax-ledger.csv'); });
  $('adj-save').addEventListener('click', function () {
    var tax = cents($('adj-tax').value); var gross = cents($('adj-gross').value); var taxable = cents($('adj-taxable').value);
    if (badAmount(tax) || badAmount(gross) || badAmount(taxable)) { say('Enter each amount in dollars, for example 12.34 or -12.34.'); return; }
    if (!tax && !gross && !taxable) { say('Enter at least one amount to correct.'); return; }
    if (!confirm('Post this correction to the permanent ledger for ' + $('adj-state').value + '? It cannot be edited afterwards; a mistake is fixed by another correction.')) return;
    act(api('POST', API + '/adjustments', { state: $('adj-state').value, channel: $('adj-channel').value, remitter: $('adj-remitter').value, tax_collected_cents: tax || 0,
      gross_cents: gross || 0, taxable_cents: taxable || 0, occurred_on: $('adj-date').value || undefined, reverses_entry_id: $('adj-entry').value.trim() || undefined, reason: $('adj-reason').value }),
    'Correction posted.', function () { ['adj-tax', 'adj-gross', 'adj-taxable', 'adj-date', 'adj-entry', 'adj-reason'].forEach(function (i) { $(i).value = ''; }); ledgerPage.offset = 0; loadLedger(); loaded.overview = false; });
  });

  // ── registrations and filings ──────────────────────────────────────────────────────────────────────────────────
  var editingReg = null; var editingFiling = null; var payingFiling = null;
  function withStates(done) {
    if (STATES.length) { done(); return; }
    api('GET', API + '/registrations').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load.')); return; }
      STATES = r.data.states;
      ['reg-state', 'fil-state', 'adj-state', 'nx-state', 'ex-state'].forEach(function (id) { fillStates($(id), STATES, false); });
      fillStates($('lf-state'), STATES, true);
      done(r.data);
    }).catch(netErr);
  }
  function resetReg() {
    editingReg = null; $('reg-form-title').textContent = 'Record a registration'; $('reg-cancel').hidden = true; $('reg-state').disabled = false;
    ['reg-from', 'reg-to', 'reg-last4', 'reg-notes', 'reg-freq'].forEach(function (i) { $(i).value = ''; });
    $('reg-status').value = 'pending'; $('reg-zero').checked = true; $('reg-proc').checked = false;
  }
  function loadRegistrations() {
    return api('GET', API + '/registrations').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load registrations.')); return; }
      var tb = clear($('reg-rows'));
      if (!r.data.registrations.length) empty(tb, 9, 'No registrations recorded. A rule under which Advantage.Bid collects and remits needs an active registration for its state.');
      r.data.registrations.forEach(function (x) {
        var tr = el('tr'); tr.setAttribute('data-state', x.state);
        tr.appendChild(td(x.state));
        var s = el('td'); s.appendChild(badge(x.status.charAt(0).toUpperCase() + x.status.slice(1), x.status === 'active' ? 'b-ok' : x.status === 'pending' ? 'b-warn' : '')); tr.appendChild(s);
        tr.appendChild(td((x.effective_from || 'Not set') + (x.effective_to ? ' to ' + x.effective_to : '')));
        tr.appendChild(td(x.filing_frequency || 'Not set')); tr.appendChild(td(x.zero_filing_required ? 'Required' : 'Not required'));
        tr.appendChild(td(x.registration_last4 ? 'Ends ' + x.registration_last4 : '')); tr.appendChild(td(x.processor_registered ? 'Confirmed' : 'Not confirmed'));
        tr.appendChild(td(x.notes || ''));
        var a = el('td'); a.appendChild(button('Edit', 'btn-mut', function () {
          editingReg = x.id; $('reg-form-title').textContent = 'Update the ' + x.state + ' registration'; $('reg-cancel').hidden = false;
          $('reg-state').value = x.state; $('reg-state').disabled = true; $('reg-status').value = x.status; $('reg-from').value = x.effective_from || ''; $('reg-to').value = x.effective_to || '';
          $('reg-freq').value = x.filing_frequency || ''; $('reg-last4').value = x.registration_last4 || ''; $('reg-zero').checked = !!x.zero_filing_required;
          $('reg-proc').checked = !!x.processor_registered; $('reg-notes').value = x.notes || ''; $('reg-form-title').scrollIntoView();
        })); tr.appendChild(a);
        tb.appendChild(tr);
      });
    }).catch(netErr);
  }
  $('reg-cancel').addEventListener('click', resetReg);
  $('reg-save').addEventListener('click', function () {
    var b = { status: $('reg-status').value, effective_from: $('reg-from').value || null, effective_to: $('reg-to').value || null, filing_frequency: $('reg-freq').value || null,
      registration_last4: $('reg-last4').value.trim(), zero_filing_required: $('reg-zero').checked, processor_registered: $('reg-proc').checked, notes: $('reg-notes').value };
    var call = editingReg ? api('PUT', API + '/registrations/' + editingReg, b) : api('POST', API + '/registrations', Object.assign({ state: $('reg-state').value }, b));
    act(call, 'Registration saved.', function () { resetReg(); loadRegistrations(); loaded.overview = false; });
  });

  function resetFiling() {
    editingFiling = null; $('fil-form-title').textContent = 'Add a filing'; $('fil-cancel').hidden = true;
    ['fil-state', 'fil-start', 'fil-end'].forEach(function (i) { $(i).disabled = false; });
    ['fil-start', 'fil-end', 'fil-due', 'fil-amount', 'fil-filed', 'fil-method', 'fil-conf', 'fil-notes'].forEach(function (i) { $(i).value = ''; });
    $('fil-status').value = 'open';
  }
  function loadFilings() {
    return api('GET', API + '/filings').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load filings.')); return; }
      var tb = clear($('fil-rows'));
      if (!r.data.length) empty(tb, 9, 'No filings yet.');
      r.data.forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(td(x.state)); tr.appendChild(td(x.period_start + ' to ' + x.period_end));
        tr.appendChild(td(x.due_date || 'Not entered'));
        var s = el('td'); s.appendChild(badge(x.status === 'paid' ? 'Paid' : x.status === 'filed' ? 'Filed' : 'Open', x.status === 'open' ? 'b-warn' : 'b-ok')); tr.appendChild(s);
        tr.appendChild(td(x.tax_due_cents == null ? '' : money(x.tax_due_cents), 'num'));
        tr.appendChild(td((x.filed_at || '') + (x.filed_by_method ? ' (' + x.filed_by_method + ')' : ''))); tr.appendChild(td(x.confirmation_number || '')); tr.appendChild(td(x.notes || ''));
        var a = el('td');
        a.appendChild(button('Edit', 'btn-mut', function () {
          editingFiling = x.id; $('fil-form-title').textContent = 'Update the ' + x.state + ' filing for ' + x.period_start + ' to ' + x.period_end; $('fil-cancel').hidden = false;
          $('fil-state').value = x.state; $('fil-start').value = x.period_start; $('fil-end').value = x.period_end;
          ['fil-state', 'fil-start', 'fil-end'].forEach(function (i) { $(i).disabled = true; });
          $('fil-due').value = x.due_date || ''; $('fil-status').value = x.status === 'paid' ? 'filed' : x.status; $('fil-amount').value = x.tax_due_cents == null ? '' : (x.tax_due_cents / 100).toFixed(2);
          $('fil-filed').value = x.filed_at || ''; $('fil-method').value = x.filed_by_method || ''; $('fil-conf').value = x.confirmation_number || ''; $('fil-notes').value = x.notes || '';
          $('fil-form-title').scrollIntoView();
        }));
        if (x.status !== 'paid') a.appendChild(button('Record Payment', 'btn-ok', function () {
          payingFiling = x; $('pay-card').hidden = false; $('pay-title').textContent = 'Record a payment: ' + x.state + ', ' + x.period_start + ' to ' + x.period_end;
          $('pay-amount').value = x.tax_due_cents == null ? '' : (x.tax_due_cents / 100).toFixed(2); $('pay-card').scrollIntoView();
        }));
        a.appendChild(button('Export for the Return', 'btn-mut', function () {
          download(API + '/filing-export.csv' + qs({ state: x.state, from: x.period_start, to: x.period_end }), 'sales-tax-return-' + x.state + '.csv');
        }));
        tr.appendChild(a); tb.appendChild(tr);
      });
    }).catch(netErr);
  }
  $('fil-cancel').addEventListener('click', resetFiling);
  $('fil-save').addEventListener('click', function () {
    var amt = cents($('fil-amount').value);
    if (badAmount(amt) || (amt != null && amt < 0)) { say('Enter the amount on the return in dollars.'); return; }
    var b = { due_date: $('fil-due').value || null, tax_due_cents: amt, filed_at: $('fil-filed').value || null, filed_by_method: $('fil-method').value || null,
      confirmation_number: $('fil-conf').value, notes: $('fil-notes').value };
    var call;
    if (editingFiling) {
      // A paid filing keeps its status: only its details are updated.
      var current = $('fil-status').value; b.status = current;
      call = api('PUT', API + '/filings/' + editingFiling, b).then(function (r) {
        if (!r.success && (r.code === 'FILING_PAID')) { delete b.status; return api('PUT', API + '/filings/' + editingFiling, b); }
        return r;
      });
    } else {
      call = api('POST', API + '/filings', Object.assign({ state: $('fil-state').value, period_start: $('fil-start').value, period_end: $('fil-end').value, status: $('fil-status').value }, b));
    }
    act(call, 'Filing saved.', function () { resetFiling(); loadFilings(); loaded.overview = false; });
  });
  $('fil-ensure').addEventListener('click', function () {
    api('POST', API + '/filings/ensure-current').then(function (r) {
      if (!r.success) { say(why(r, 'Not done.')); return; }
      say(r.data.created.length ? r.data.created.length + ' filing row(s) opened. Enter each due date.' : 'Every closed period already has its filing row.', true); loadFilings();
    }).catch(netErr);
  });
  $('pay-cancel').addEventListener('click', function () { payingFiling = null; $('pay-card').hidden = true; });
  $('pay-save').addEventListener('click', function () {
    if (!payingFiling) return;
    var amt = cents($('pay-amount').value);
    if (amt == null || badAmount(amt) || amt <= 0) { say('Enter the amount paid, in dollars.'); return; }
    if (!confirm('Record a payment of ' + money(amt) + ' to ' + payingFiling.state + '? This records a payment you already made. It is posted to the permanent ledger.')) return;
    act(api('POST', API + '/filings/' + payingFiling.id + '/payment', { amount_cents: amt, paid_on: $('pay-date').value || undefined, reference: $('pay-ref').value, note: $('pay-note').value }),
      'Payment recorded.', function () { payingFiling = null; $('pay-card').hidden = true; ['pay-amount', 'pay-date', 'pay-ref', 'pay-note'].forEach(function (i) { $(i).value = ''; }); loadFilings(); loaded.overview = false; });
  });
  LOADERS.registrations = function () { withStates(function () { loadRegistrations(); loadFilings(); }); };

  // ── rules (summary; the rules page edits them) ─────────────────────────────────────────────────────────────────
  LOADERS.rules = function () { if (!overviewData) loadOverview(); };

  // ── tax codes ──────────────────────────────────────────────────────────────────────────────────────────────────
  function loadCodes() {
    return api('GET', API + '/category-codes').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load tax codes.')); return; }
      var sel = $('code-cat');
      if (!sel.options.length) r.data.categories.forEach(function (c) { var o = el('option', c.label); o.value = c.key; sel.appendChild(o); });
      var byKey = {}; r.data.mappings.forEach(function (m) { byKey[m.category_key] = m; });
      var tb = clear($('code-rows'));
      r.data.categories.forEach(function (c) {
        var m = byKey[c.key]; var tr = el('tr');
        tr.appendChild(td(c.label));
        if (m) { tr.appendChild(td(m.tax_code)); } else { var g = el('td'); g.appendChild(el('span', 'General code for tangible goods (no mapping)', 'small')); tr.appendChild(g); }
        tr.appendChild(td(m ? m.source_reference || '' : '')); tr.appendChild(td(m ? m.notes || '' : '')); tr.appendChild(td(m ? when(m.updated_at) : ''));
        var a = el('td');
        a.appendChild(button(m ? 'Edit' : 'Map', 'btn-mut', function () {
          sel.value = c.key; $('code-code').value = m ? m.tax_code : ''; $('code-source').value = m ? m.source_reference || '' : ''; $('code-notes').value = m ? m.notes || '' : ''; sel.scrollIntoView();
        }));
        if (m) a.appendChild(button('Remove', 'btn-danger', function () {
          if (!confirm('Remove the mapping for ' + c.label + '? It will use the general code for tangible goods.')) return;
          act(api('DELETE', API + '/category-codes/' + encodeURIComponent(c.key)), 'Mapping removed.', loadCodes);
        }));
        tr.appendChild(a); tb.appendChild(tr);
      });
    }).catch(netErr);
  }
  LOADERS.codes = loadCodes;
  $('code-save').addEventListener('click', function () {
    act(api('PUT', API + '/category-codes/' + encodeURIComponent($('code-cat').value), { tax_code: $('code-code').value.trim(), source_reference: $('code-source').value, notes: $('code-notes').value }),
      'Mapping saved.', function () { ['code-code', 'code-source', 'code-notes'].forEach(function (i) { $(i).value = ''; }); loadCodes(); });
  });

  // ── nexus ──────────────────────────────────────────────────────────────────────────────────────────────────────
  var NX = { physical_presence: ['Physical presence', 'b-info'], registered: ['Registered', 'b-ok'], exceeded: ['Threshold reached', 'b-bad'], near: ['Near threshold', 'b-warn'],
    approaching: ['Approaching', 'b-warn'], below: ['Below', 'b-ok'], no_threshold: ['No threshold entered', 'b-warn'], review: ['Needs review', 'b-warn'] };
  var NXP = { calendar_year: 'Current calendar year', previous_calendar_year: 'Previous calendar year', current_or_previous_calendar_year: 'Current or previous calendar year', rolling_12_months: 'Rolling 12 months' };
  function thresholdText(t) {
    if (!t) return 'None entered';
    var parts = [];
    if (t.sales_threshold_cents != null) parts.push(money(t.sales_threshold_cents) + ' in sales');
    if (t.transaction_threshold != null) parts.push(t.transaction_threshold + ' transactions');
    return (parts.length ? parts.join(t.combine_rule === 'and' ? ' and ' : ' or ') : 'No amount entered') + (t.physical_presence ? '; physical presence' : '');
  }
  function loadNexus() {
    api('GET', API + '/nexus/status').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load the nexus status.')); return; }
      var tb = clear($('nx-status'));
      if (!r.data.length) empty(tb, 8, 'No sales, thresholds or registrations yet.');
      r.data.forEach(function (s) {
        var tr = el('tr'); var w = s.measured || s.windows.current;
        tr.appendChild(td(s.state));
        var c = el('td'); var lab = NX[s.status] || [s.status, '']; c.appendChild(badge(lab[0], lab[1]));
        if ((s.status === 'no_threshold' || s.status === 'review') && s.has_sales) c.appendChild(el('div', 'Has sales: review', 'small'));
        tr.appendChild(c);
        tr.appendChild(td(s.overall_pct == null ? '' : s.overall_pct + '%', 'num'));
        tr.appendChild(num(w.sales_cents)); tr.appendChild(td(String(w.transactions), 'num'));
        var ch = el('td');
        Object.keys(w.by_channel || {}).forEach(function (k) { var v = w.by_channel[k]; if (v.sales_cents || v.transactions) ch.appendChild(el('div', (CHANNEL[k] || k) + ': ' + money(v.sales_cents) + ', ' + v.transactions, 'small')); });
        tr.appendChild(ch);
        var th = el('td', thresholdText(s.threshold)); if (s.threshold) th.appendChild(el('div', NXP[s.threshold.measurement_period] || '', 'small')); tr.appendChild(th);
        tr.appendChild(td(s.registration_status ? s.registration_status.charAt(0).toUpperCase() + s.registration_status.slice(1) : 'None recorded'));
        tb.appendChild(tr);
      });
    }).catch(netErr);
    api('GET', API + '/nexus/thresholds').then(function (r) {
      if (!r.success) return;
      var tb = clear($('nx-rows'));
      if (!r.data.thresholds.length) empty(tb, 7, 'No thresholds entered. Enter each one from the state’s published rule.');
      r.data.thresholds.forEach(function (t) {
        var tr = el('tr');
        tr.appendChild(td(t.state)); tr.appendChild(td(thresholdText(t))); tr.appendChild(td(NXP[t.measurement_period] || t.measurement_period));
        tr.appendChild(td(t.counts_marketplace_sales == null ? 'Not yet determined' : t.counts_marketplace_sales ? 'Yes' : 'No'));
        var lr = el('td', t.legal_reference); if (t.source_url) lr.appendChild(el('div', t.source_url, 'small')); tr.appendChild(lr);
        tr.appendChild(td(t.verified_at || 'Not verified'));
        var a = el('td');
        a.appendChild(button('Edit', 'btn-mut', function () {
          $('nx-state').value = t.state; $('nx-sales').value = t.sales_threshold_cents == null ? '' : (t.sales_threshold_cents / 100).toFixed(2);
          $('nx-tx').value = t.transaction_threshold == null ? '' : t.transaction_threshold; $('nx-combine').value = t.combine_rule; $('nx-period').value = t.measurement_period;
          $('nx-counts').value = t.counts_marketplace_sales == null ? '' : String(t.counts_marketplace_sales); $('nx-eff').value = t.effective_from || ''; $('nx-verified').value = t.verified_at || '';
          $('nx-physical').checked = !!t.physical_presence; $('nx-legal').value = t.legal_reference || ''; $('nx-url').value = t.source_url || ''; $('nx-notes').value = t.notes || '';
          $('nx-state').scrollIntoView();
        }));
        a.appendChild(button('Remove', 'btn-danger', function () {
          if (!confirm('Remove the threshold for ' + t.state + '?')) return;
          act(api('DELETE', API + '/nexus/thresholds/' + t.state), 'Threshold removed.', loadNexus);
        }));
        tr.appendChild(a); tb.appendChild(tr);
      });
    }).catch(netErr);
  }
  LOADERS.nexus = function () { withStates(loadNexus); };
  $('nx-save').addEventListener('click', function () {
    var sales = cents($('nx-sales').value);
    if (badAmount(sales) || (sales != null && sales < 0)) { say('Enter the sales threshold in dollars, or leave it empty.'); return; }
    var tx = $('nx-tx').value.trim();
    if (tx && !/^\d+$/.test(tx)) { say('Enter the transaction threshold as a whole number, or leave it empty.'); return; }
    var counts = $('nx-counts').value;
    act(api('PUT', API + '/nexus/thresholds/' + $('nx-state').value, { sales_threshold_cents: sales, transaction_threshold: tx ? Number(tx) : null, combine_rule: $('nx-combine').value,
      measurement_period: $('nx-period').value, counts_marketplace_sales: counts === '' ? null : counts === 'true', physical_presence: $('nx-physical').checked,
      legal_reference: $('nx-legal').value, source_url: $('nx-url').value.trim() || null, effective_from: $('nx-eff').value || null, verified_at: $('nx-verified').value || null, notes: $('nx-notes').value }),
    'Threshold saved.', function () {
      ['nx-sales', 'nx-tx', 'nx-eff', 'nx-verified', 'nx-legal', 'nx-url', 'nx-notes', 'nx-counts'].forEach(function (i) { $(i).value = ''; }); $('nx-physical').checked = false; loadNexus();
    });
  });

  // ── exceptions and holds ───────────────────────────────────────────────────────────────────────────────────────
  function loadExceptions() {
    return api('GET', API + '/exceptions').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load exceptions.')); return; }
      var tb = clear($('ex-rows'));
      if (!r.data.length) empty(tb, 6, 'No exceptions recorded.');
      r.data.forEach(function (x) {
        var tr = el('tr');
        var a = el('td', x.auction_title || 'Auction'); a.appendChild(el('div', x.auction_id, 'small')); tr.appendChild(a);
        tr.appendChild(td(x.state)); tr.appendChild(td(x.reason)); tr.appendChild(td(when(x.created_at)));
        var s = el('td'); s.appendChild(badge(x.revoked_at ? 'Revoked' : 'Active', x.revoked_at ? '' : 'b-warn')); if (x.revoked_at) s.appendChild(el('div', when(x.revoked_at), 'small')); tr.appendChild(s);
        var act2 = el('td');
        if (!x.revoked_at) act2.appendChild(button('Revoke', 'btn-danger', function () {
          if (!confirm('Revoke this exception? Later payments for this auction in ' + x.state + ' follow the normal safeguard again.')) return;
          act(api('POST', API + '/exceptions/' + x.id + '/revoke'), 'Exception revoked.', loadExceptions);
        }));
        tr.appendChild(act2); tb.appendChild(tr);
      });
    }).catch(netErr);
  }
  LOADERS.exceptions = function () { withStates(function () { loadExceptions(); loadAlerts(); }); };
  $('ex-save').addEventListener('click', function () {
    if (!confirm('Record this exception? Payments for this auction in ' + $('ex-state').value + ' will proceed without sales tax collected.')) return;
    act(api('POST', API + '/exceptions', { auction_id: $('ex-auction').value.trim(), state: $('ex-state').value, reason: $('ex-reason').value }),
      'Exception recorded.', function () { $('ex-auction').value = ''; $('ex-reason').value = ''; loadExceptions(); });
  });

  // ── seller reporting ───────────────────────────────────────────────────────────────────────────────────────────
  function loadSellers() {
    var sel = $('sr-year');
    if (!sel.options.length) { var y = new Date().getFullYear(); for (var i = 0; i < 6; i++) { var o = el('option', String(y - i)); o.value = String(y - i); sel.appendChild(o); } }
    return api('GET', API + '/seller-reporting' + qs({ year: sel.value })).then(function (r) {
      if (!r.success) { say(why(r, 'Could not load seller reporting.')); return; }
      $('sr-note').textContent = r.data.message + ' Sellers are listed by name only; no taxpayer numbers are stored here.';
      var tb = clear($('sr-rows'));
      if (!r.data.sellers.length) empty(tb, 7, 'No sales or seller payments recorded for ' + r.data.year + '.');
      r.data.sellers.forEach(function (s) {
        var tr = el('tr');
        tr.appendChild(td(s.seller_name || 'Seller ' + String(s.seller_profile_id).slice(0, 8)));
        tr.appendChild(num(s.gross_sales_cents)); tr.appendChild(num(s.refunds_cents)); tr.appendChild(td(String(s.transaction_count), 'num'));
        tr.appendChild(num(s.paid_auction_cents)); tr.appendChild(num(s.paid_storefront_cents)); tr.appendChild(num(s.paid_total_cents));
        tb.appendChild(tr);
      });
      var tf = clear($('sr-totals')); var t = el('tr');
      t.appendChild(td('All sellers')); t.appendChild(num(r.data.totals.gross_sales_cents)); t.appendChild(num(r.data.totals.refunds_cents)); t.appendChild(td(String(r.data.totals.transaction_count), 'num'));
      var gap = td(''); gap.colSpan = 2; t.appendChild(gap); t.appendChild(num(r.data.totals.paid_total_cents)); tf.appendChild(t);
    }).catch(netErr);
  }
  LOADERS.sellers = loadSellers;
  $('sr-year').addEventListener('change', loadSellers);
  $('sr-csv').addEventListener('click', function () { download(API + '/seller-reporting.csv' + qs({ year: $('sr-year').value }), 'seller-reporting.csv'); });

  show(location.hash.replace('#', '') || 'overview', true);
})();
