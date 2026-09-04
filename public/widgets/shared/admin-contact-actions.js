/* ============================================================================
   AdminContactActions — the ONE Admin Quick-Contact control. Renders fast
   one-click contact actions for a platform user: Email, Call, Copy Email,
   Copy Phone, and a gated Text button.

   Usage (async, resolves the authoritative deliverable address server-side):
     AdminContactActions.mount(el, { userId: '<uuid>' });
   Or with pre-resolved data (e.g. already fetched by the page):
     AdminContactActions.render(el, { name, email, phone, sms_enabled });

   Rules baked in:
     - Email/phone come from GET /api/admin/contact/:userId (recipientService +
       users.phone). The component NEVER guesses an address.
     - Text is GATED: disabled unless sms_enabled is true (Twilio pending). It
       shows "SMS activation pending" and never attempts to send.
     - No AI wording, no vendor names, plain language.
   ========================================================================== */
(function (root) {
  'use strict';

  function h(tag, attrs, text) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    if (text != null) el.textContent = text;
    return el;
  }

  function copy(text, btn) {
    if (!text) return;
    var done = function () { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done).catch(function () {}); }
    else { try { var t = h('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); done(); } catch (e) {} }
  }

  function btn(label, opts) {
    opts = opts || {};
    var b = h(opts.href ? 'a' : 'button', { 'class': 'adm-contact-btn' + (opts.disabled ? ' is-disabled' : '') }, label);
    if (opts.href && !opts.disabled) { b.setAttribute('href', opts.href); }
    if (opts.title) b.setAttribute('title', opts.title);
    if (opts.disabled) { b.setAttribute('aria-disabled', 'true'); if (b.tagName === 'BUTTON') b.disabled = true; }
    if (opts.onClick && !opts.disabled) b.addEventListener('click', opts.onClick);
    return b;
  }

  function render(el, data) {
    el.innerHTML = '';
    var wrap = h('div', { 'class': 'adm-contact', role: 'group', 'aria-label': 'Contact ' + (data.name || 'user') });
    var email = data.email || '';
    var phone = data.phone || '';

    wrap.appendChild(btn('Email', {
      href: email ? 'mailto:' + email : null, disabled: !email,
      title: email || 'No email on file',
    }));
    wrap.appendChild(btn('Call', {
      href: phone ? 'tel:' + String(phone).replace(/[^0-9+]/g, '') : null, disabled: !phone,
      title: phone || 'No phone on file',
    }));
    wrap.appendChild(btn('Copy Email', { disabled: !email, title: email || 'No email on file', onClick: function () { copy(email, this); } }));
    wrap.appendChild(btn('Copy Phone', { disabled: !phone, title: phone || 'No phone on file', onClick: function () { copy(phone, this); } }));

    // Text is gated until SMS is activated (Twilio pending). Never sends.
    var textEnabled = !!data.sms_enabled && !!phone;
    wrap.appendChild(btn('Text', {
      disabled: !textEnabled,
      title: data.sms_enabled ? (phone || 'No phone on file') : 'SMS activation pending',
    }));
    if (!data.sms_enabled) {
      wrap.appendChild(h('span', { 'class': 'adm-contact-note' }, 'SMS activation pending'));
    }
    el.appendChild(wrap);
    return wrap;
  }

  function mount(el, opts) {
    opts = opts || {};
    if (opts.userId == null) { render(el, opts); return; }
    var token = (root.Auth && root.Auth.getToken && root.Auth.getToken()) || localStorage.getItem('token') || '';
    fetch('/api/admin/contact/' + encodeURIComponent(opts.userId), {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      credentials: 'include',
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { render(el, d || { name: 'user' }); })
      .catch(function () { render(el, { name: 'user' }); });
  }

  // Minimal styles injected once (no external stylesheet dependency).
  function injectStyles() {
    if (document.getElementById('adm-contact-styles')) return;
    var css = '.adm-contact{display:inline-flex;gap:6px;flex-wrap:wrap;align-items:center}'
      + '.adm-contact-btn{display:inline-block;padding:4px 10px;font-size:13px;line-height:1.4;border:1px solid #cbd5e1;'
      + 'border-radius:6px;background:#fff;color:#1e293b;cursor:pointer;text-decoration:none}'
      + '.adm-contact-btn:hover{background:#f1f5f9}'
      + '.adm-contact-btn.is-disabled{opacity:.5;cursor:not-allowed;pointer-events:none}'
      + '.adm-contact-note{font-size:12px;color:#64748b}';
    var s = h('style', { id: 'adm-contact-styles' }); s.appendChild(document.createTextNode(css));
    document.head.appendChild(s);
  }
  if (typeof document !== 'undefined') injectStyles();

  root.AdminContactActions = { mount: mount, render: render };
})(typeof window !== 'undefined' ? window : this);
