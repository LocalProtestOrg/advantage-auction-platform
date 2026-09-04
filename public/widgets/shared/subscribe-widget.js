/* ============================================================================
   AdvSubscribe — the ONE reusable Advantage.Bid first-party subscriber signup.
   Self-mounting. Works on Railway public pages and embeds on Brilliant
   Directories pages. All form logic lives here once (no per-page duplication).

   Usage — drop a mount element anywhere and include this script:
     <div data-adv-subscribe data-placement="footer"></div>
     <script src="/widgets/shared/subscribe-widget.js" defer></script>

   Attributes:
     data-placement  footer | all_events | auctions_listing | estate_sales_listing
                     | auction_detail | estate_sale_detail | marketplace
                     | professional_directory | blog | help_center | seller_page | other
     data-variant    visual style: 'bar' (compact, default) | 'card'
     data-endpoint   override API base (for BD cross-origin embeds; default same-origin)
     data-title / data-subtitle  optional copy overrides

   Collects Name + Email + City + State (ZIP optional). No account required.
   No AI/vendor terminology. Accessible + mobile friendly.
   ========================================================================== */
(function (root) {
  'use strict';
  var MOUNTED = '__advSubscribeMounted';

  // Context-aware default copy per placement (meaning preserved; not manipulative; no frequency promise).
  var COPY = {
    footer:               { t: 'Stay in the loop', s: 'Get upcoming auctions, estate sales and interesting finds near you.' },
    all_events:           { t: 'Find sales near you', s: "Tell us where you are and we'll keep you posted about upcoming auctions and estate sales nearby." },
    auctions_listing:     { t: "Don't miss the next one", s: 'Get upcoming Advantage.Bid auctions near you.' },
    estate_sales_listing: { t: 'Estate sales near you', s: 'Get notified about upcoming sales in your area.' },
    auction_detail:       { t: "Don't miss the next one", s: 'Get upcoming Advantage.Bid auctions near you.' },
    estate_sale_detail:   { t: 'Estate sales near you', s: 'Get notified about upcoming sales in your area.' },
    marketplace:          { t: 'Stay in the loop', s: 'Get upcoming auctions, estate sales and interesting finds near you.' },
    other:                { t: 'Stay in the loop', s: 'Get upcoming auctions, estate sales and interesting finds near you.' }
  };

  var STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function injectStyles() {
    if (document.getElementById('adv-subscribe-styles')) return;
    var css =
      '.adv-sub{--asb:#0B1B2B;--asa:#c8a86b;font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:720px}' +
      '.adv-sub h3{margin:0 0 2px;font-size:1.05rem;color:var(--asb)}' +
      '.adv-sub p.adv-sub-sub{margin:0 0 10px;font-size:.9rem;color:#5b6b7e}' +
      '.adv-sub form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}' +
      '.adv-sub input,.adv-sub select{padding:9px 10px;font-size:14px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#0B1B2B;min-width:0}' +
      '.adv-sub input[name=name],.adv-sub input[name=email]{flex:1 1 180px}' +
      '.adv-sub input[name=city]{flex:1 1 130px}.adv-sub select[name=state]{flex:0 0 92px}.adv-sub input[name=zip]{flex:0 0 96px}' +
      '.adv-sub button{padding:9px 16px;font-size:14px;font-weight:600;border:0;border-radius:8px;background:var(--asb);color:#fff;cursor:pointer;flex:0 0 auto}' +
      '.adv-sub button:hover{background:#12314f}.adv-sub button:disabled{opacity:.6;cursor:default}' +
      '.adv-sub .adv-sub-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}' +
      '.adv-sub .adv-sub-msg{margin-top:8px;font-size:.9rem}.adv-sub .adv-sub-msg.ok{color:#166534}.adv-sub .adv-sub-msg.err{color:#b91c1c}' +
      '.adv-sub.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px}';
    var s = el('style', { id: 'adv-subscribe-styles' }); s.appendChild(document.createTextNode(css));
    document.head.appendChild(s);
  }

  function endpointFor(mount) {
    var base = mount.getAttribute('data-endpoint');
    return (base ? base.replace(/\/$/, '') : '') + '/api/public/subscribers';
  }

  function build(mount) {
    var placement = (mount.getAttribute('data-placement') || 'other').toLowerCase();
    var variant = (mount.getAttribute('data-variant') || 'bar').toLowerCase();
    var copy = COPY[placement] || COPY.other;
    var title = mount.getAttribute('data-title') || copy.t;
    var subtitle = mount.getAttribute('data-subtitle') || copy.s;

    var wrap = el('div', { 'class': 'adv-sub' + (variant === 'card' ? ' card' : ''), role: 'region', 'aria-label': 'Subscribe for updates' });
    wrap.appendChild(el('h3', { text: title }));
    wrap.appendChild(el('p', { 'class': 'adv-sub-sub', text: subtitle }));

    var form = el('form', { novalidate: 'novalidate' });
    var name = el('input', { name: 'name', type: 'text', placeholder: 'Name', 'aria-label': 'Your name', autocomplete: 'name' });
    var email = el('input', { name: 'email', type: 'email', placeholder: 'Email', 'aria-label': 'Your email', autocomplete: 'email', required: 'required' });
    var city = el('input', { name: 'city', type: 'text', placeholder: 'City', 'aria-label': 'Your city', autocomplete: 'address-level2' });
    var state = el('select', { name: 'state', 'aria-label': 'Your state', autocomplete: 'address-level1' });
    state.appendChild(el('option', { value: '', text: 'State' }));
    STATES.forEach(function (s) { state.appendChild(el('option', { value: s, text: s })); });
    var zip = el('input', { name: 'zip', type: 'text', placeholder: 'ZIP (optional)', 'aria-label': 'Your ZIP code', inputmode: 'numeric', autocomplete: 'postal-code', maxlength: '10' });
    // Honeypot (hidden from humans + assistive tech).
    var hp = el('input', { name: 'company_url', type: 'text', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    var hpWrap = el('div', { 'class': 'adv-sub-hp' }, [hp]);
    var btn = el('button', { type: 'submit', text: 'Sign Me Up' });
    [name, email, city, state, zip, hpWrap, btn].forEach(function (n) { form.appendChild(n); });
    var msg = el('div', { 'class': 'adv-sub-msg', role: 'status', 'aria-live': 'polite' });
    wrap.appendChild(form); wrap.appendChild(msg);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      msg.className = 'adv-sub-msg'; msg.textContent = '';
      if (!email.value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) {
        msg.className = 'adv-sub-msg err'; msg.textContent = 'Please enter a valid email address.'; email.focus(); return;
      }
      btn.disabled = true;
      var payload = {
        name: name.value, email: email.value, city: city.value, state: state.value, zip: zip.value,
        company_url: hp.value, placement: placement, page_path: location.pathname + location.search
      };
      fetch(endpointFor(mount), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      }).then(function (r) { return r.json().catch(function () { return { success: r.ok }; }); })
        .then(function (d) {
          if (d && d.success) {
            form.style.display = 'none';
            msg.className = 'adv-sub-msg ok';
            msg.textContent = (d.message) || "You're in! We'll keep you posted about auctions and estate sales near you.";
          } else {
            btn.disabled = false; msg.className = 'adv-sub-msg err';
            msg.textContent = (d && d.message) || 'Something went wrong. Please try again.';
          }
        }).catch(function () { btn.disabled = false; msg.className = 'adv-sub-msg err'; msg.textContent = 'Something went wrong. Please try again.'; });
    });

    return wrap;
  }

  function mountAll(scope) {
    injectStyles();
    var nodes = (scope || document).querySelectorAll('[data-adv-subscribe]');
    for (var i = 0; i < nodes.length; i++) {
      var m = nodes[i];
      if (m[MOUNTED]) continue;
      m[MOUNTED] = true;
      m.appendChild(build(m));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mountAll(document); });
  else mountAll(document);

  root.AdvSubscribe = { mountAll: mountAll };
})(typeof window !== 'undefined' ? window : this);
