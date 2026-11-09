/* Admin: storefront sales tax responsibility per state (public/admin/tax-jurisdictions.html). DOM calls; values as text. */
(function () {
  'use strict';
  var token = null; try { token = localStorage.getItem('token'); } catch (e) { /* no storage */ }
  if (!token) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname); return; }
  function api(m, u, b) {
    return fetch(u, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: b ? JSON.stringify(b) : undefined })
      .then(function (r) { if (r.status === 401) { location.href = '/login.html'; throw new Error('auth'); } return r.json(); });
  }
  function $(id) { return document.getElementById(id); }
  function say(t, ok) { $('msg').textContent = t || ''; $('msg').style.color = ok ? '#166534' : '#991b1b'; }
  function el(tag, text) { var e = document.createElement(tag); if (text != null) e.textContent = text; return e; }
  function load() {
    api('GET', '/api/admin/tax-jurisdictions').then(function (r) {
      if (!r.success) { say(r.message || 'Could not load.'); return; }
      var sel = $('st');
      if (!sel.options.length) r.data.states.forEach(function (s) { var o = el('option', s); o.value = s; sel.appendChild(o); });
      var tb = $('rows'); while (tb.firstChild) tb.removeChild(tb.firstChild);
      if (!r.data.rules.length) {
        var tr0 = el('tr'); var td0 = el('td', 'No rules yet. Every storefront order is refused until a rule exists for its state.'); td0.colSpan = 6;
        tr0.appendChild(td0); tb.appendChild(tr0);
      }
      r.data.rules.forEach(function (x) {
        var tr = el('tr');
        [x.state, ({ platform: 'Collected at checkout; Advantage.Bid remits', seller: 'Collected at checkout; the seller remits', seller_direct: 'Not collected at checkout; the seller handles its own tax' })[x.remitter] || x.remitter, x.legal_basis, String(x.effective_from).slice(0, 10), new Date(x.updated_at).toLocaleString()]
          .forEach(function (v) { tr.appendChild(el('td', v)); });
        var td = el('td'); var b = el('button', 'Remove'); b.className = 'btn btn-mut'; b.type = 'button';
        b.addEventListener('click', function () {
          if (!confirm('Remove the rule for ' + x.state + '? Every storefront order there will be refused.')) return;
          api('DELETE', '/api/admin/tax-jurisdictions/' + x.state).then(function () { say('Rule removed.', true); load(); });
        });
        td.appendChild(b); tr.appendChild(td); tb.appendChild(tr);
      });
    }).catch(function () { say('Network error.'); });
  }
  $('save').addEventListener('click', function () {
    api('PUT', '/api/admin/tax-jurisdictions/' + $('st').value, { remitter: $('rem').value, legal_basis: $('basis').value,
      effective_from: $('eff').value || undefined, notes: $('notes').value })
      .then(function (r) { if (!r.success) { say(r.message || 'Not saved.'); return; } say('Saved.', true); load(); })
      .catch(function () { say('Network error.'); });
  });
  load();
})();
