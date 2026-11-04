/* Admin: storefront seller payouts (public/admin/storefront-payouts.html; API /api/admin/storefront-payouts). Built with
   DOM calls; every value is set as text. */
(function () {
  'use strict';
  var token = null; try { token = localStorage.getItem('token'); } catch (e) { /* no storage */ }
  if (!token) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname); return; }
  function api(method, url, body) {
    return fetch(url, { method: method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { if (r.status === 401) { location.href = '/login.html'; throw new Error('auth'); } return r.json(); });
  }
  function money(c) { return '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function say(t, ok) { var m = document.getElementById('msg'); m.textContent = t || ''; m.style.color = ok ? '#166534' : '#991b1b'; }
  var STATUS = { pending_review: 'Ready to review', on_hold: 'On hold', paid: 'Paid', void: 'Void' };
  var PAYOUT = { pending: '', processing: 'Transfer sent', released: 'Transfer confirmed', reversed: 'Transfer reversed' };

  function button(label, cls, fn) { var b = el('button', label, 'btn ' + cls); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function act(promise, okText) {
    return promise.then(function (r) { if (!r.success) { say(r.message || 'Not done.'); return; } say(okText, true); load(); })
      .catch(function () { say('Network error.'); });
  }
  function render(list) {
    var tb = document.getElementById('rows'); while (tb.firstChild) tb.removeChild(tb.firstChild);
    if (!list.length) { var tr0 = el('tr'); var td0 = el('td', 'No storefront payouts yet.', 'small'); td0.colSpan = 9; tr0.appendChild(td0); tb.appendChild(tr0); return; }
    list.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', p.seller_name || p.seller_profile_id));
      tr.appendChild(el('td', new Date(p.period_cutoff_at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET'));
      tr.appendChild(el('td', String(p.order_count), 'num'));
      tr.appendChild(el('td', money(p.goods_cents), 'num'));
      tr.appendChild(el('td', money(p.platform_fee_cents), 'num'));
      tr.appendChild(el('td', money(p.seller_payout_cents), 'num'));
      var st = el('td'); st.appendChild(el('span', STATUS[p.settlement_status] || p.settlement_status, 'badge b-' + p.settlement_status));
      if (p.on_hold_reason) st.appendChild(el('div', p.on_hold_reason, 'small'));
      if (p.void_reason) st.appendChild(el('div', p.void_reason, 'small'));
      tr.appendChild(st);
      tr.appendChild(el('td', (PAYOUT[p.payout_status] || '') + (p.transfer_failure_message ? ' (' + p.transfer_failure_message + ')' : ''), 'small'));
      var acts = el('td');
      acts.appendChild(button('Orders', 'btn-mut', function () { toggleLines(p, tr); }));
      if (p.settlement_status === 'pending_review') {
        acts.appendChild(button('Pay Seller', 'btn-ok', function () { pay(p); }));
        acts.appendChild(button('Hold', 'btn-mut', function () {
          var why = prompt('Why is this payout on hold?'); if (!why) return;
          act(api('POST', '/api/admin/storefront-payouts/' + p.id + '/hold', { reason: why }), 'Payout placed on hold.');
        }));
      }
      if (p.settlement_status === 'on_hold') acts.appendChild(button('Release Hold', 'btn-mut', function () { act(api('POST', '/api/admin/storefront-payouts/' + p.id + '/release'), 'Hold released.'); }));
      if (p.settlement_status === 'pending_review' || p.settlement_status === 'on_hold') {
        acts.appendChild(button('Void', 'btn-danger', function () {
          var why = prompt('Why void this payout? Its orders become available for a later payout.'); if (!why) return;
          act(api('POST', '/api/admin/storefront-payouts/' + p.id + '/void', { reason: why }), 'Payout voided.');
        }));
      }
      tr.appendChild(acts);
      tb.appendChild(tr);
    });
  }
  function toggleLines(p, tr) {
    var next = tr.nextSibling;
    if (next && next.className === 'lines') { next.parentNode.removeChild(next); return; }
    api('GET', '/api/admin/storefront-payouts/' + p.id).then(function (r) {
      if (!r.success) { say(r.message || 'Could not load.'); return; }
      var row = el('tr'); row.className = 'lines'; var td = el('td'); td.colSpan = 9;
      (r.data.lines || []).forEach(function (l) {
        td.appendChild(el('div', (l.active ? '' : '[removed] ') + l.order_number + ' · ' + (l.title || 'Item') + (l.quantity > 1 ? ' x ' + l.quantity : '')
          + ' · goods ' + money(l.goods_cents) + ' · fee ' + money(l.platform_fee_cents) + ' · seller ' + money(l.amount_cents) + ' · ' + (l.fulfillment_status || '')));
      });
      (r.data.adjustments || []).forEach(function (a) {
        td.appendChild(el('div', 'Commission correction · ' + (a.order_number || '') + ' · ' + a.from_label + ' to ' + a.to_label + ' · '
          + (a.amount_cents > 0 ? 'credit ' : 'charge ') + money(Math.abs(a.amount_cents)) + (a.outside_review_window ? ' · after the 60-day window (override)' : '') + ' · ' + a.reason));
      });
      if (r.data.recovery_cents) td.appendChild(el('div', 'Refund recoveries deducted: ' + money(r.data.recovery_cents)));
      row.appendChild(td); tr.parentNode.insertBefore(row, tr.nextSibling);
    });
  }
  function pay(p) {
    if (!confirm('Pay ' + (p.seller_name || 'this seller') + ' ' + money(p.seller_payout_cents) + ' by transfer to their connected payout account?\n\nConfirm that every included order was fulfilled.')) return;
    var typed = prompt('Type the payout amount to confirm (for example ' + (p.seller_payout_cents / 100).toFixed(2) + '):');
    if (typed == null) return;
    var cents = Math.round(Number(String(typed).replace(/[$,\s]/g, '')) * 100);
    act(api('POST', '/api/admin/storefront-payouts/' + p.id + '/pay', { confirmed_completed: true, final_amount_cents: cents }), 'Payment sent to the seller.');
  }
  function load() {
    var s = document.getElementById('status').value;
    api('GET', '/api/admin/storefront-payouts' + (s ? '?status=' + encodeURIComponent(s) : '')).then(function (r) {
      if (!r.success) { say(r.message || 'Could not load payouts.'); return; } render(r.data || []);
    }).catch(function () { say('Network error.'); });
    api('GET', '/api/admin/storefront-payouts/cutoff').then(function (r) {
      if (r.success) document.getElementById('cutoff').textContent = 'Current cutoff: ' + new Date(r.data.cutoff).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET';
    }).catch(function () {});
  }
  document.getElementById('status').addEventListener('change', load);
  document.getElementById('reload').addEventListener('click', load);
  document.getElementById('prepare').addEventListener('click', function () {
    act(api('POST', '/api/admin/storefront-payouts/prepare'), 'Payouts prepared for the latest cutoff.');
  });
  load();
})();
