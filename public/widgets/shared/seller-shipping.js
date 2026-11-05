/* Seller auction shipping controls (Phase 1). Shown ONLY when the server reports auction shipping turned on
   (GET /api/auction-shipping/config). The server enforces every rule; this file only presents it.
     SellerShipping.mountSetup(container)    auction setup: eligibility, payout explanation, one-time acknowledgment,
                                             reusable shipping settings (profiles)
     SellerShipping.mountLot(container)      lot editor: "This lot can ship" (off by default) + settings picker
     SellerShipping.loadLot(lotId)           fill the lot controls from the saved lot
     SellerShipping.resetLot()               back to Local Pickup (off)
     SellerShipping.saveLot(lotId)           Promise<{ ok, message }>; no-op when the controls are hidden
   Built with DOM calls only (no markup strings with closing tags). */
(function () {
  'use strict';
  var API = '/api/auction-shipping';
  var state = { enabled: null, status: null, lotMounted: false, lotTouched: false, lotLoadedId: null };

  function token() { try { return localStorage.getItem('token'); } catch (e) { return null; } }
  function req(method, path, body) {
    var h = { 'Authorization': 'Bearer ' + token() };
    if (body) h['Content-Type'] = 'application/json';
    return fetch(API + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); });
  }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') e.style.cssText = attrs[k]; else if (k === 'className') e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function dollars(c) { return c == null ? '' : (Number(c) / 100).toFixed(2); }
  function cents(v) { var n = parseFloat(String(v || '').replace(/[$,]/g, '')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; }

  function config() {
    if (state.enabled !== null) return Promise.resolve(state.enabled);
    return fetch(API + '/config').then(function (r) { return r.json(); })
      .then(function (j) { state.enabled = !!(j && j.data && j.data.enabled); return state.enabled; })
      .catch(function () { state.enabled = false; return false; });
  }
  function loadStatus() {
    return req('GET', '/seller/status').then(function (j) { state.status = j && j.success ? j.data : null; return state.status; });
  }

  var NOTE = 'margin:0.5rem 0;padding:0.65rem 0.8rem;border-radius:8px;font-size:0.85rem;line-height:1.45;';
  function payoutBox(status) {
    var box = el('div', { style: NOTE + 'background:#fffbeb;border:1px solid #f59e0b;color:#78350f;' });
    box.appendChild(el('strong', null, 'How shipping affects your payout'));
    box.appendChild(el('div', { style: 'margin-top:0.25rem' }, (status && status.payout_explanation) || ''));
    return box;
  }

  // ── Auction setup ────────────────────────────────────────────────────────────────────────────────────────────
  function mountSetup(container) {
    if (!container) return Promise.resolve();
    return config().then(function (on) {
      if (!on) { container.style.display = 'none'; return; }
      return loadStatus().then(function (s) { renderSetup(container, s); });
    });
  }

  function renderSetup(container, s) {
    clear(container);
    container.style.display = '';
    container.appendChild(el('p', { className: 'section-title' }, 'Shipping'));
    container.appendChild(el('p', { className: 'hint', style: 'margin:0 0 0.4rem' },
      'Local Pickup is the default. Only lots you mark "This lot can ship" in the Lot Studio offer shipping, and buyers see that before they bid.'));
    if (!s) { container.appendChild(el('p', { className: 'hint' }, 'Shipping settings could not be loaded. Please refresh.')); return; }
    container.appendChild(payoutBox(s));
    if (!s.eligible) { container.appendChild(el('div', { style: NOTE + 'background:#f3f4f6;color:#374151;' }, s.message || '')); return; }
    if (s.needs_acknowledgment) { renderAcknowledge(container, s); return; }
    var limit = el('div', { className: 'hint' }, 'Your shipping limit: $' + dollars(s.per_shipment_limit_cents)
      + ' total item value per shipment. Every shipment needs tracking; orders above $' + dollars(s.signature_threshold_cents) + ' need signature confirmation.');
    container.appendChild(limit);
    renderProfiles(container, s);
  }

  function renderAcknowledge(container, s) {
    var box = el('div', { style: NOTE + 'background:#f9fafb;border:1px solid #e5e7eb;color:#111827;' });
    box.appendChild(el('strong', null, 'Before you turn shipping on'));
    var ul = el('ul', { style: 'margin:0.35rem 0 0.5rem 1.1rem;padding:0' });
    (s.education || []).forEach(function (t) { ul.appendChild(el('li', { style: 'margin:0.15rem 0' }, t)); });
    box.appendChild(ul);
    var row = el('label', { style: 'display:flex;gap:0.5rem;align-items:flex-start;font-weight:600' });
    var cb = el('input', { type: 'checkbox', id: 'ship-ack-check' });
    row.appendChild(cb);
    row.appendChild(el('span', null, 'I have read how shipping affects my payout and how to avoid shipping scams.'));
    box.appendChild(row);
    var btn = el('button', { type: 'button', className: 'btn btn-primary', style: 'margin-top:0.5rem' }, 'Turn on shipping tools');
    var msg = el('div', { className: 'hint', role: 'status' });
    btn.addEventListener('click', function () {
      if (!cb.checked) { msg.textContent = 'Please check the box to confirm you have read this.'; return; }
      btn.disabled = true;
      req('POST', '/seller/acknowledge', { acknowledged: true }).then(function (j) {
        btn.disabled = false;
        if (!j.success) { msg.textContent = j.message || 'Could not save. Please try again.'; return; }
        state.status = j.data; renderSetup(container, j.data);
      }).catch(function () { btn.disabled = false; msg.textContent = 'Network error. Please try again.'; });
    });
    box.appendChild(btn); box.appendChild(msg);
    container.appendChild(box);
  }

  function field(labelText, input, hint) {
    var f = el('div', { className: 'field' });
    var l = el('label', null, labelText);
    f.appendChild(l); f.appendChild(input);
    if (hint) f.appendChild(el('p', { className: 'hint' }, hint));
    return f;
  }

  function renderProfiles(container, s) {
    var wrap = el('div', { id: 'ship-profiles' });
    container.appendChild(wrap);
    var profiles = s.profiles || [];
    var pick = el('select', { id: 'ship-profile-pick' });
    profiles.forEach(function (p) { var o = el('option', { value: p.id }, p.name + (p.is_default ? ' (default)' : '')); pick.appendChild(o); });
    pick.appendChild(el('option', { value: '' }, 'New shipping settings'));
    wrap.appendChild(field('Shipping settings', pick, 'Reusable settings. Each lot that can ship uses your default unless you choose another.'));
    var form = el('div');
    wrap.appendChild(form);

    function drawForm(p) {
      clear(form);
      var name = el('input', { type: 'text', maxlength: '80', id: 'ship-name' }); name.value = p ? p.name : 'Standard shipping';
      var method = el('select', { id: 'ship-method' });
      method.appendChild(el('option', { value: 'quote_required' }, 'Quote required (you quote shipping after the auction)'));
      method.appendChild(el('option', { value: 'flat_rate' }, 'Flat rate per lot'));
      method.value = p ? p.method : 'quote_required';
      var rate = el('input', { type: 'text', inputmode: 'decimal', id: 'ship-rate', placeholder: '0.00' }); rate.value = p && p.flat_rate_cents != null ? dollars(p.flat_rate_cents) : '';
      var rateField = field('Flat rate ($)', rate);
      var hd = el('input', { type: 'number', min: '1', max: '30', id: 'ship-handling' }); hd.value = p ? p.handling_days : 3;
      var ex = el('input', { type: 'text', id: 'ship-excluded', placeholder: 'e.g. AK, HI' }); ex.value = p && p.excluded_states ? p.excluded_states.join(', ') : '';
      var note = el('textarea', { id: 'ship-note', maxlength: '500', rows: '2' }); note.value = p && p.packaging_note ? p.packaging_note : '';
      var def = el('input', { type: 'checkbox', id: 'ship-default' }); def.checked = !!(p && p.is_default);
      form.appendChild(field('Name', name));
      form.appendChild(field('Shipping cost', method));
      form.appendChild(rateField);
      form.appendChild(field('Handling time (business days after payment)', hd));
      form.appendChild(field('Ships within the United States. States you do not ship to (optional)', ex));
      form.appendChild(field('Packaging note for buyers (optional)', note));
      var dl = el('label', { style: 'display:flex;gap:0.4rem;align-items:center;margin:0.3rem 0' }); dl.appendChild(def); dl.appendChild(el('span', null, 'Use as my default'));
      form.appendChild(dl);
      function syncRate() { rateField.style.display = method.value === 'flat_rate' ? '' : 'none'; }
      method.addEventListener('change', syncRate); syncRate();
      var actions = el('div', { style: 'display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.4rem' });
      var save = el('button', { type: 'button', className: 'btn btn-primary' }, 'Save shipping settings');
      var msg = el('div', { className: 'hint', role: 'status' });
      save.addEventListener('click', function () {
        var body = { name: name.value, method: method.value, flat_rate_cents: method.value === 'flat_rate' ? cents(rate.value) : null,
          handling_days: parseInt(hd.value, 10), excluded_states: ex.value, packaging_note: note.value };
        if (def.checked) body.is_default = true;
        save.disabled = true;
        var call = p ? req('PATCH', '/seller/profiles/' + encodeURIComponent(p.id), body) : req('POST', '/seller/profiles', body);
        call.then(function (j) {
          save.disabled = false;
          if (!j.success) { msg.textContent = j.message || 'Could not save. Please check the fields.'; return; }
          msg.textContent = 'Saved.';
          loadStatus().then(function (st) { if (st) { clear(container); renderSetup(container, st); } });
        }).catch(function () { save.disabled = false; msg.textContent = 'Network error. Please try again.'; });
      });
      actions.appendChild(save);
      if (p) {
        var arch = el('button', { type: 'button', className: 'btn' }, 'Remove these settings');
        arch.addEventListener('click', function () {
          req('DELETE', '/seller/profiles/' + encodeURIComponent(p.id)).then(function (j) {
            if (!j.success) { msg.textContent = j.message || 'Could not remove.'; return; }
            loadStatus().then(function (st) { if (st) { clear(container); renderSetup(container, st); } });
          });
        });
        actions.appendChild(arch);
      }
      form.appendChild(actions); form.appendChild(msg);
    }
    function current() { var id = pick.value; for (var i = 0; i < profiles.length; i++) if (profiles[i].id === id) return profiles[i]; return null; }
    pick.addEventListener('change', function () { drawForm(current()); });
    drawForm(current());
  }

  // ── Lot editor ───────────────────────────────────────────────────────────────────────────────────────────────
  var lotEls = {};
  function mountLot(container) {
    if (!container) return Promise.resolve();
    return config().then(function (on) {
      if (!on) { container.style.display = 'none'; return; }
      return loadStatus().then(function (s) { renderLot(container, s); });
    });
  }

  function renderLot(container, s) {
    clear(container);
    container.style.display = '';
    container.appendChild(el('div', { className: 'form-label' }, 'Shipping'));
    if (!s || !s.can_enable) {
      container.appendChild(el('div', { className: 'inline-toggle-sub' }, 'Local Pickup. ' + ((s && s.message) || 'Turn on shipping tools in your auction settings first.')));
      state.lotMounted = false;
      return;
    }
    var row = el('label', { style: 'display:flex;gap:0.5rem;align-items:center;font-weight:600' });
    var cb = el('input', { type: 'checkbox', id: 'lot-can-ship' });
    row.appendChild(cb); row.appendChild(el('span', null, 'This lot can ship'));
    container.appendChild(row);
    var more = el('div', { style: 'margin-top:0.4rem;display:none' });
    var pick = el('select', { id: 'lot-ship-profile', className: 'form-select' });
    (s.profiles || []).forEach(function (p) { var o = el('option', { value: p.id }, p.name + (p.is_default ? ' (default)' : '')); if (p.is_default) o.selected = true; pick.appendChild(o); });
    var quote = el('input', { type: 'checkbox', id: 'lot-ship-quote' });
    var ql = el('label', { style: 'display:flex;gap:0.4rem;align-items:center;margin:0.35rem 0' }); ql.appendChild(quote); ql.appendChild(el('span', null, 'Quote required for this lot (for example, large or fragile)'));
    var restr = el('input', { type: 'text', id: 'lot-ship-restriction', maxlength: '300', className: 'form-input', placeholder: 'Optional restriction shown to buyers, e.g. "Frame ships without glass"' });
    more.appendChild(pick); more.appendChild(ql); more.appendChild(restr);
    more.appendChild(el('div', { style: NOTE + 'background:#fffbeb;border:1px solid #f59e0b;color:#78350f;' },
      'Payout for a shipped lot is held until delivery is confirmed, plus 3 business days. Shipping limit: $' + dollars(s.per_shipment_limit_cents) + ' total item value per shipment.'));
    container.appendChild(more);
    container.appendChild(el('div', { className: 'inline-toggle-sub' }, 'Off = Local Pickup only. Shipping terms cannot change after bidding starts.'));
    function sync() { more.style.display = cb.checked ? '' : 'none'; }
    [cb, pick, quote, restr].forEach(function (x) { x.addEventListener('change', function () { state.lotTouched = true; sync(); }); x.addEventListener('input', function () { state.lotTouched = true; }); });
    lotEls = { cb: cb, pick: pick, quote: quote, restr: restr, sync: sync };
    state.lotMounted = true;
    sync();
  }

  function resetLot() {
    state.lotTouched = false; state.lotLoadedId = null;
    if (!state.lotMounted) return;
    lotEls.cb.checked = false; lotEls.quote.checked = false; lotEls.restr.value = '';
    var d = (state.status && state.status.profiles || []).filter(function (p) { return p.is_default; })[0];
    if (d) lotEls.pick.value = d.id;
    lotEls.sync();
  }

  function loadLot(lotId) {
    resetLot();
    if (!state.lotMounted || !lotId) return Promise.resolve();
    return req('GET', '/lots/' + encodeURIComponent(lotId)).then(function (j) {
      if (!j.success || !j.data) return;
      state.lotLoadedId = lotId;
      lotEls.cb.checked = !!j.data.shipping_eligible;
      if (j.data.shipping_profile_id) lotEls.pick.value = j.data.shipping_profile_id;
      lotEls.quote.checked = !!j.data.shipping_quote_required;
      lotEls.restr.value = j.data.shipping_restriction || '';
      lotEls.sync();
    }).catch(function () {});
  }

  function saveLot(lotId) {
    if (!state.lotMounted || !lotId || !state.lotTouched) return Promise.resolve({ ok: true });
    var body = lotEls.cb.checked
      ? { shipping_eligible: true, shipping_profile_id: lotEls.pick.value || null, shipping_quote_required: !!lotEls.quote.checked, shipping_restriction: lotEls.restr.value }
      : { shipping_eligible: false };
    return req('PUT', '/lots/' + encodeURIComponent(lotId), body)
      .then(function (j) { return j.success ? { ok: true } : { ok: false, message: j.message || 'Shipping was not saved.' }; })
      .catch(function () { return { ok: false, message: 'Shipping was not saved (network error).' }; });
  }

  window.SellerShipping = { mountSetup: mountSetup, mountLot: mountLot, loadLot: loadLot, resetLot: resetLot, saveLot: saveLot };
})();
