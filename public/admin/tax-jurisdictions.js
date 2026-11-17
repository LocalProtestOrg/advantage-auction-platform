/* Admin: the sales tax rule per state, for every kind of sale (public/admin/tax-jurisdictions.html). DOM calls; values as text. */
(function () {
  'use strict';
  var token = null; try { token = localStorage.getItem('token'); } catch (e) { /* no storage */ }
  if (!token) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname); return; }
  function api(m, u, b) {
    return fetch(u, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: b ? JSON.stringify(b) : undefined })
      .then(function (r) { if (r.status === 401) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname); throw new Error('auth'); } return r.json(); });
  }
  function $(id) { return document.getElementById(id); }
  function say(t, ok) { $('msg').textContent = t || ''; $('msg').style.color = ok ? '#166534' : '#991b1b'; }
  function why(r, fallback) { return (r && (r.message || r.error)) || fallback; }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function button(label, cls, fn) { var b = el('button', label, 'btn btn-sm ' + cls); b.type = 'button'; b.addEventListener('click', fn); return b; }
  var LABEL = { platform: 'Collected at checkout; Advantage.Bid remits', seller_direct: 'Not collected at checkout; the seller is responsible',
    seller: 'Collected at checkout; paid to the seller' };
  var ACTION = { set: 'Saved', removed: 'Removed', verified: 'Verified' };

  function fill(x) {
    $('st').value = x.state;
    if (x.remitter !== 'seller') $('rem').value = x.remitter;
    $('basis').value = x.legal_basis || ''; $('eff').value = String(x.effective_from || '').slice(0, 10);
    $('source').value = x.source_reference || ''; $('local').value = x.local_jurisdiction || ''; $('notes').value = x.notes || '';
    say(x.remitter === 'seller' ? 'This rule uses a retired option. Choose one of the two current options and save to replace it.' : 'Editing the rule for ' + x.state + '. Save to record the change.', true);
    window.scrollTo(0, 0);
  }
  function toggleHistory(x, tr) {
    var next = tr.nextSibling;
    if (next && next.className === 'hist') { next.parentNode.removeChild(next); return; }
    api('GET', '/api/admin/tax-jurisdictions/' + x.state + '/history').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load the history.')); return; }
      var row = el('tr'); row.className = 'hist'; var td = el('td'); td.colSpan = 8;
      if (!r.data.length) td.appendChild(el('div', 'No recorded changes yet.'));
      r.data.forEach(function (h) {
        var v = h.after_value || h.before_value || {};
        td.appendChild(el('div', new Date(h.created_at).toLocaleString() + ' · ' + (ACTION[h.action] || h.action) + ' by ' + (h.actor_name || 'an administrator')
          + (h.action === 'verified' ? '' : ' · ' + (LABEL[v.remitter] || v.remitter || '') + (v.legal_basis ? ' · ' + v.legal_basis : ''))));
      });
      row.appendChild(td); tr.parentNode.insertBefore(row, tr.nextSibling);
    }).catch(function () { say('Network error.'); });
  }
  function load() {
    api('GET', '/api/admin/tax-jurisdictions').then(function (r) {
      if (!r.success) { say(why(r, 'Could not load.')); return; }
      var sel = $('st');
      if (!sel.options.length) r.data.states.forEach(function (s) { var o = el('option', s); o.value = s; sel.appendChild(o); });
      var tb = $('rows'); while (tb.firstChild) tb.removeChild(tb.firstChild);
      if (!r.data.rules.length) {
        var tr0 = el('tr'); var td0 = el('td', 'No rules yet. Storefront orders are refused in a state without a rule, and auctions there are reported or held.'); td0.colSpan = 8;
        tr0.appendChild(td0); tb.appendChild(tr0);
      }
      r.data.rules.forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(el('td', x.state));
        var how = el('td', LABEL[x.remitter] || x.remitter);
        if (x.remitter === 'seller') { how.appendChild(document.createTextNode(' ')); how.appendChild(el('span', 'Retired', 'badge')); how.appendChild(el('div', 'New sales treat this state as having no rule. Replace it.', 'small')); }
        tr.appendChild(how);
        tr.appendChild(el('td', x.legal_basis));
        var src = el('td');
        if (x.source_reference) src.appendChild(el('div', x.source_reference));
        if (x.local_jurisdiction) src.appendChild(el('div', 'Local: ' + x.local_jurisdiction, 'small'));
        if (x.notes) src.appendChild(el('div', x.notes, 'small'));
        tr.appendChild(src);
        tr.appendChild(el('td', String(x.effective_from || '').slice(0, 10)));
        tr.appendChild(el('td', x.last_verified_at ? String(x.last_verified_at).slice(0, 10) : 'Never'));
        tr.appendChild(el('td', new Date(x.updated_at).toLocaleString()));
        var td = el('td');
        td.appendChild(button('Edit', 'btn-mut', function () { fill(x); }));
        td.appendChild(button('Mark Verified', 'btn-mut', function () {
          if (!confirm('Record that you checked the rule for ' + x.state + ' against its source today?')) return;
          api('POST', '/api/admin/tax-jurisdictions/' + x.state + '/verify').then(function (v) {
            if (!v.success) { say(why(v, 'Not recorded.')); return; } say('Verification recorded.', true); load();
          }).catch(function () { say('Network error.'); });
        }));
        td.appendChild(button('History', 'btn-mut', function () { toggleHistory(x, tr); }));
        td.appendChild(button('Remove', 'btn-danger', function () {
          if (!confirm('Remove the rule for ' + x.state + '? Storefront orders there will be refused, and auctions there will be reported or held.')) return;
          api('DELETE', '/api/admin/tax-jurisdictions/' + x.state).then(function (d) {
            if (!d.success) { say(why(d, 'Not removed.')); return; } say('Rule removed.', true); load();
          }).catch(function () { say('Network error.'); });
        }));
        tr.appendChild(td); tb.appendChild(tr);
      });
    }).catch(function () { say('Network error.'); });
  }
  $('save').addEventListener('click', function () {
    api('PUT', '/api/admin/tax-jurisdictions/' + $('st').value, { remitter: $('rem').value, legal_basis: $('basis').value,
      effective_from: $('eff').value || undefined, notes: $('notes').value, source_reference: $('source').value, local_jurisdiction: $('local').value })
      .then(function (r) { if (!r.success) { say(why(r, 'Not saved.')); return; } say('Saved.', true); load(); })
      .catch(function () { say('Network error.'); });
  });
  load();
})();
