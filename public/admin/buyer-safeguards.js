/* Admin Buyer Management: Terms and Email Confirmation panel.
 * Read-only terms acceptance summary per Buyer Terms version (the acceptance ledger is never changed here), and the
 * "verified email required to bid" switch with its grace period (audited on the server). DOM calls only.
 */
(function () {
  'use strict';
  var root = document.getElementById('safeguards');
  if (!root) return;
  var token = null; try { token = localStorage.getItem('token'); } catch (e) { token = null; }
  function api(method, url, body) {
    var o = { method: method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } };
    if (body !== undefined) o.body = JSON.stringify(body);
    return fetch(url, o).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
  }
  function el(tag, text, attrs) {
    var n = document.createElement(tag);
    if (text != null) n.textContent = text;
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function d(v) { return v ? new Date(v).toLocaleDateString() : '-'; }

  function render(data) {
    root.textContent = '';
    root.appendChild(el('h2', 'Terms and Email Confirmation', { style: 'margin:0 0 6px;font-size:1.05rem' }));
    var a = data.accounts || {};
    root.appendChild(el('div', (a.buyers_accepted_current || 0) + ' of ' + (a.buyers || 0) + ' active buyers have accepted the current terms. '
      + (a.buyers_email_verified || 0) + ' have a confirmed email; ' + (a.unverified_buyers_with_bids || 0) + ' unconfirmed buyers have bid before.', { class: 'msg' }));

    var t = el('table'); var head = el('tr');
    ['Version', 'Title', 'Current', 'Effective', 'Acceptances', 'First accepted', 'Last accepted'].forEach(function (h) { head.appendChild(el('th', h)); });
    var thead = el('thead'); thead.appendChild(head); t.appendChild(thead);
    var tb = el('tbody');
    (data.terms_versions || []).forEach(function (v) {
      var tr = el('tr');
      [String(v.version_int), v.title || '', v.is_current ? 'Yes' : '', d(v.effective_at), String(v.acceptances), d(v.first_accepted_at), d(v.last_accepted_at)]
        .forEach(function (c) { tr.appendChild(el('td', c)); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); root.appendChild(t);

    var e = data.email_verification || {};
    var box = el('div', null, { style: 'margin-top:12px;font-size:14px' });
    box.appendChild(el('strong', 'Confirmed email required to bid: ' + (e.required ? 'ON' : 'OFF')));
    box.appendChild(el('div', e.required
      ? 'Since ' + d(e.required_since) + '. Buyers who bid or bought before then may keep bidding for ' + e.grace_days + ' days while they are asked to confirm.'
      : 'When turned on, new accounts must confirm their email before registering or bidding; buyers who already bid or bought keep bidding for the grace period while they are asked to confirm.', { class: 'msg' }));
    var lbl = el('label', 'Grace period (days) ', { style: 'font-size:13px;margin-right:8px' });
    var days = el('input', null, { type: 'number', min: '0', max: '365', value: String(e.grace_days == null ? 30 : e.grace_days), style: 'width:5rem;padding:5px' });
    lbl.appendChild(days); box.appendChild(lbl);
    var save = el('button', 'Save Grace Period', { type: 'button', class: 'btn btn-mut' });
    var toggle = el('button', e.required ? 'Turn Off Requirement' : 'Turn On Requirement', { type: 'button', class: e.required ? 'btn btn-danger' : 'btn btn-go' });
    var msg = el('div', '', { class: 'msg', role: 'status' });
    box.appendChild(save); box.appendChild(toggle); box.appendChild(msg);
    root.appendChild(box);

    function send(patch, confirmText) {
      if (confirmText && !window.confirm(confirmText)) return;
      msg.textContent = 'Saving…';
      api('POST', '/api/admin/buyers/safeguards/email-verification', patch).then(function (r) {
        if (!r.ok || !r.d.success) { msg.textContent = (r.d && r.d.message) || 'Could not save.'; return; }
        load();
      }).catch(function () { msg.textContent = 'Could not save.'; });
    }
    save.addEventListener('click', function () { send({ grace_days: Number(days.value) }); });
    toggle.addEventListener('click', function () {
      send({ required: !e.required }, e.required ? 'Turn off the confirmed-email requirement for bidding?'
        : 'Turn on the confirmed-email requirement? Unconfirmed new accounts will be asked to confirm before registering or bidding; established buyers get the grace period. See docs/operations/buyer-verification-transition.md first.');
    });
  }

  function load() {
    api('GET', '/api/admin/buyers/safeguards').then(function (r) {
      if (r.ok && r.d.success) render(r.d.data); else root.textContent = 'Could not load the terms summary.';
    }).catch(function () { root.textContent = 'Could not load the terms summary.'; });
  }
  load();
})();
