/* ============================================================================
   AdvLocalAlerts — "Never Miss a Sale Near You Again!"

   ONE self-mounting script that gives a casual visitor two low-friction chances
   to subscribe to local auction + estate-sale alerts:

     1. a quiet footer strip, present in the normal page flow;
     2. a polished modal, shown only after REAL engagement.

   It creates no new backend. Both surfaces post to the existing, certified
   first-party endpoint POST /api/public/subscribers (subscriberService →
   marketing_contacts), which already handles geocoding, explicit-opt-in
   permission evidence, source attribution, idempotency and the kill switch.

   Three fields only — Email, City, State. No login, no password, no account,
   no preference form, no radius setting. The visitor should never have to
   understand how matching works in order to be matched.

   WHERE IT REFUSES TO APPEAR. The modal must never interrupt money, bidding,
   security or a seller mid-workflow, so SUPPRESSED_PATHS is checked before
   anything renders — belt and braces alongside only including the script on
   public marketing pages.

   SEO + performance. Nothing is fetched. Styles are injected once. The modal's
   DOM is built only when it is actually triggered, so there is no duplicate
   crawlable content and no layout shift, and a crawler — which never scrolls,
   moves a pointer or dwells — never triggers it at all.

   TWO SURFACES, ONE SCRIPT. This file runs unchanged on Railway (bid.advantage.bid)
   and on the Brilliant Directories marketing site (advantage.bid). Only two things
   differ cross-origin:

     1. WHERE IT POSTS. On Railway the endpoints are same-origin. On BD a relative
        '/api/public/subscribers' would post to BD itself and silently lose every
        signup, so the API base is resolved from this script's own src. Railway
        remains the single source of truth; BD stores nothing.

     2. WHICH PATHS ARE SENSITIVE. BD has its own login/account/checkout routes, so
        the suppression list covers both vocabularies.

   BD embed (Owner pastes this once, ideally in the global footer block):

     <script src="https://bid.advantage.bid/widgets/shared/local-alerts.js"
             data-placement="bd_footer" defer></script>

   `data-placement` is optional; when omitted the script classifies the BD page
   itself so source attribution stays meaningful without per-page configuration.
   ========================================================================== */
(function (root) {
  'use strict';

  // The Railway origin this script was served from. document.currentScript is correct during the
  // synchronous parse; the querySelector fallback covers a deferred/async re-entry. Falls back to
  // same-origin (the Railway case), so a failure to resolve can never post somewhere unexpected.
  var API_BASE = (function () {
    try {
      var el = document.currentScript
        || document.querySelector('script[src*="/widgets/shared/local-alerts.js"]');
      var src = el && el.getAttribute('src');
      if (src && /^https?:\/\//i.test(src)) {
        var u = new URL(src);
        if (u.origin !== location.origin) return u.origin;   // cross-origin embed (BD)
      }
    } catch (e) { /* fall through to same-origin */ }
    return '';                                               // same-origin (Railway)
  })();
  var SCRIPT_EL = (function () {
    try {
      return document.currentScript
        || document.querySelector('script[src*="/widgets/shared/local-alerts.js"]');
    } catch (e) { return null; }
  })();
  var EMBEDDED = API_BASE !== '';                            // true only on BD

  var ENDPOINT = API_BASE + '/api/public/subscribers';
  var ANALYTICS_ENDPOINT = API_BASE + '/api/analytics/events';
  var STORE = 'adv_alerts_v1';
  var SESSION_SHOWN = 'adv_alerts_shown_session';
  var DETAIL_VIEWS = 'adv_alerts_detail_views';

  // Frequency policy. Deliberately conservative: this is a nicety, not a toll gate.
  var POLICY = {
    engagedMs: 25000,          // ~25s of ACTUAL engagement (hidden tabs do not count)
    detailViewsToTrigger: 2,   // or the second event/auction they look at
    dismissDays: 30,           // a dismissal is respected for a month
    showEveryDays: 7,          // never more than once a week even without a dismissal
    maxLifetimeShows: 3,       // and never more than three times, ever
    exitIntentMinWidth: 1024,  // desktop only; exit intent is meaningless on touch
  };

  // The modal never appears on these. Money, bidding, security, seller workflow, admin.
  var SUPPRESSED_PATHS = new RegExp([
    '^/admin', '^/app\\.html', '^/dashboard', '^/login', '^/signup', '^/reset-password',
    '^/auction-view',                       // live bidding
    '^/payment', '^/billing', '^/add-card', '^/checkout', '^/invoices',
    '^/account', '^/my-bids', '^/watchlist', '^/marketplace-purchases',
    '^/seller-', '^/lot-builder', '^/create-estate-sale', '^/my-estate-sales',
    '^/payout-', '^/sign-agreement', '^/verify-', '^/my-agreements',
    '^/claim-listing', '^/authorize-event-promotion', '^/org/',
    '^/auction\.html',                     // private member auction page (htmlAuthGate MEMBER_PAGES)
    '^/forgot-password', '^/reset-password', // account security
    '^/data-deletion', '^/pricing-agreement',
    '^/terms', '^/privacy', '^/buyer-terms', // legal reading, not a marketing moment
    '^/appraiser-welcome', '^/estate-sale-welcome',  // post-conversion seller context
    // ── Brilliant Directories route vocabulary. BD names its sensitive pages differently, and a
    //    signup prompt must not appear over a login, an account area, a cart or a checkout there
    //    either. Matching is prefix-based on the path, same as above.
    '^/login', '^/logout', '^/signup', '^/register', '^/join',
    '^/password', '^/forgot', '^/reset',
    '^/account', '^/my-account', '^/my-', '^/member', '^/members',
    '^/dashboard', '^/profile', '^/settings',
    '^/cart', '^/checkout', '^/billing', '^/invoice', '^/subscribe-',
    '^/admin', '^/wp-admin',
    '^/privacy', '^/terms', '^/legal', '^/dmca', '^/cookie'
  ].join('|'), 'i');

  /**
   * Source attribution. An explicit data-placement wins. Otherwise the BD page is classified from
   * its own path so attribution stays meaningful without the Owner configuring every page. The
   * server keeps its own allowlist and collapses anything unrecognised to 'other', so this can
   * never inject an arbitrary label.
   */
  function resolvePlacement(surface) {
    try {
      var explicit = SCRIPT_EL && SCRIPT_EL.getAttribute('data-placement');
      if (explicit) return String(explicit).toLowerCase();
    } catch (e) { /* fall through */ }
    if (!EMBEDDED) return surface === 'modal' ? 'modal' : 'footer';
    var p = (location.pathname || '/').toLowerCase();
    if (/estate[-_ ]?sale/.test(p)) return 'bd_estate_sales';
    if (/auction/.test(p)) return 'bd_auctions';
    if (/(professional|directory|companies|vendors)/.test(p)) return 'bd_directory';
    if (/(blog|article|news|post)/.test(p)) return 'bd_blog';
    if (/(city|state|location|near)/.test(p)) return 'bd_city_page';
    if (p === '/' || p === '/index' || p === '/home') return 'bd_home';
    return 'bd_other';
  }

  // Pages where a detail view counts toward the "second event viewed" trigger.
  // Railway detail routes, plus the BD equivalents so the "second event viewed" trigger works on
  // either surface.
  var DETAIL_PATH = /^\/(event|auction-view|lot)(\.html|\/|$)|^\/(estate-sales?|auctions?|listing|event)s?\/[^/]+/i;

  var STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS',
    'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH',
    'OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

  // ── Storage helpers. Every access is guarded: private mode and blocked cookies
  //    must degrade to "show nothing intrusive", never to an exception. ─────────
  function readState() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeState(patch) {
    try {
      var s = readState();
      Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
      localStorage.setItem(STORE, JSON.stringify(s));
    } catch (e) { /* storage blocked — the visitor simply gets default behaviour */ }
  }
  function days(ms) { return ms / 86400000; }

  // ── Analytics. Fire-and-forget through the shared first-party helper. ────────
  function track(type, meta) {
    try {
      var payload = Object.assign({ path: location.pathname, surface: EMBEDDED ? 'bd' : 'app' }, meta || {});
      // On BD the shared helper is absent (and would post to BD's own origin), so post directly.
      if (!EMBEDDED && root.AAPAnalytics && root.AAPAnalytics.track) {
        root.AAPAnalytics.track(type, payload, {});
        return;
      }
      // The helper has not loaded yet: post directly so the signal is not lost.
      var body = JSON.stringify({
        event_type: type, page_url: location.href, client_ts: new Date().toISOString(),
        metadata: payload,
      });
      fetch(ANALYTICS_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true,
      }).catch(function () {});
    } catch (e) { /* measurement must never break the page */ }
  }

  // ── Eligibility ──────────────────────────────────────────────────────────────
  function isSuppressedPath() { return SUPPRESSED_PATHS.test(location.pathname || '/'); }

  function alreadySubscribed() {
    var s = readState();
    return s.subscribed === true;
  }

  /** May we show the MODAL right now? The footer strip is governed separately and far more loosely. */
  function modalAllowed() {
    if (isSuppressedPath()) return false;
    if (alreadySubscribed()) return false;
    // A crawler or automated browser never sees an interstitial.
    try { if (navigator.webdriver) return false; } catch (e) {}
    try { if (sessionStorage.getItem(SESSION_SHOWN)) return false; } catch (e) {}

    var s = readState();
    if (s.dismissedAt && days(Date.now() - s.dismissedAt) < POLICY.dismissDays) return false;
    if (s.shownAt && days(Date.now() - s.shownAt) < POLICY.showEveryDays) return false;
    if ((s.shownCount || 0) >= POLICY.maxLifetimeShows) return false;
    return true;
  }

  // ── Styles, injected once ────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('adv-alerts-styles')) return;
    var css =
      '.advla-strip{--b:#0B1B2B;--a:#c8a86b;font-family:system-ui,Segoe UI,Arial,sans-serif;' +
        'background:#f8fafc;border-top:1px solid #e2e8f0;padding:1.6rem 1.25rem}' +
      '.advla-in{max-width:760px;margin:0 auto}' +
      '.advla-strip h3{margin:0 0 .2rem;font-size:1.08rem;font-weight:800;color:var(--b);letter-spacing:-.01em}' +
      '.advla-strip p{margin:0 0 .85rem;font-size:.92rem;color:#5b6b7e;line-height:1.5}' +
      '.advla-f{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}' +
      '.advla-f input,.advla-f select{font:inherit;font-size:14px;padding:10px 11px;border:1px solid #cbd5e1;' +
        'border-radius:9px;background:#fff;color:#0B1B2B;min-width:0}' +
      '.advla-f input[name=email]{flex:1 1 200px}.advla-f input[name=city]{flex:1 1 140px}' +
      '.advla-f select[name=state]{flex:0 0 96px}' +
      '.advla-f input:focus,.advla-f select:focus{outline:2px solid #93c5fd;outline-offset:1px}' +
      '.advla-btn{font:inherit;font-size:14px;font-weight:700;padding:10px 18px;border:0;border-radius:9px;' +
        'background:var(--b);color:#fff;cursor:pointer;flex:0 0 auto}' +
      '.advla-btn:hover{background:#12314f}.advla-btn:disabled{opacity:.6;cursor:default}' +
      '.advla-fine{margin:.7rem 0 0;font-size:.78rem;color:#8494a6;line-height:1.5}' +
      '.advla-msg{margin:.7rem 0 0;font-size:.9rem;line-height:1.5}' +
      '.advla-ok{color:#15803d;font-weight:600}.advla-err{color:#b91c1c}' +
      /* modal */
      '.advla-ov{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9998;display:flex;' +
        'align-items:center;justify-content:center;padding:1.25rem;opacity:0;transition:opacity .18s ease}' +
      '.advla-ov.open{opacity:1}' +
      '.advla-m{position:relative;background:#fff;border-radius:16px;max-width:460px;width:100%;' +
        'padding:1.9rem 1.6rem 1.5rem;box-shadow:0 20px 60px rgba(15,23,42,.28);' +
        'transform:translateY(8px);transition:transform .18s ease}' +
      '.advla-ov.open .advla-m{transform:none}' +
      '.advla-m h2{margin:0 0 .45rem;font-size:1.42rem;font-weight:800;line-height:1.2;letter-spacing:-.02em;color:#0B1B2B}' +
      '.advla-m .advla-sub{margin:0 0 1.15rem;font-size:.97rem;color:#475569;line-height:1.55}' +
      '.advla-m .advla-f{flex-direction:column}' +
      '.advla-m .advla-f input,.advla-m .advla-f select,.advla-m .advla-btn{width:100%;flex:1 1 auto}' +
      '.advla-row{display:flex;gap:8px;width:100%}' +
      '.advla-row input[name=city]{flex:1 1 auto}.advla-row select[name=state]{flex:0 0 104px}' +
      '.advla-x{position:absolute;top:.55rem;right:.6rem;width:40px;height:40px;border:0;background:none;' +
        'font-size:1.6rem;line-height:1;color:#94a3b8;cursor:pointer;border-radius:10px}' +
      '.advla-x:hover{background:#f1f5f9;color:#475569}' +
      '.advla-no{display:block;width:100%;margin-top:.7rem;background:none;border:0;font:inherit;' +
        'font-size:.85rem;color:#8494a6;cursor:pointer;padding:.4rem;text-decoration:underline}' +
      /* mobile: a bottom sheet, never a full-screen interstitial */
      '@media (max-width:560px){' +
        '.advla-ov{align-items:flex-end;padding:0}' +
        '.advla-m{border-radius:18px 18px 0 0;padding:1.5rem 1.1rem 1.2rem;max-width:none}' +
        '.advla-m h2{font-size:1.24rem}.advla-x{width:44px;height:44px}}' +
      '@media (prefers-reduced-motion:reduce){.advla-ov,.advla-m{transition:none}}';
    var st = document.createElement('style');
    st.id = 'adv-alerts-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ── The shared form, used by both surfaces ───────────────────────────────────
  function buildForm(placement, onDone) {
    var form = document.createElement('form');
    form.className = 'advla-f';
    form.setAttribute('novalidate', 'novalidate');

    var email = document.createElement('input');
    email.type = 'email'; email.name = 'email'; email.placeholder = 'Email address';
    email.autocomplete = 'email'; email.required = true;
    email.setAttribute('aria-label', 'Email address');

    var city = document.createElement('input');
    city.type = 'text'; city.name = 'city'; city.placeholder = 'City';
    city.autocomplete = 'address-level2';
    city.setAttribute('aria-label', 'City');

    var state = document.createElement('select');
    state.name = 'state'; state.setAttribute('aria-label', 'State');
    state.autocomplete = 'address-level1';
    var blank = document.createElement('option'); blank.value = ''; blank.textContent = 'State';
    state.appendChild(blank);
    STATES.forEach(function (s) {
      var o = document.createElement('option'); o.value = s; o.textContent = s; state.appendChild(o);
    });

    // Honeypot — the endpoint drops anything that fills it. Hidden from people and assistive tech.
    var pot = document.createElement('input');
    pot.type = 'text'; pot.name = 'company_url'; pot.tabIndex = -1;
    pot.setAttribute('aria-hidden', 'true'); pot.autocomplete = 'off';
    pot.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0';

    var btn = document.createElement('button');
    btn.type = 'submit'; btn.className = 'advla-btn'; btn.textContent = 'Notify Me About Nearby Sales';

    var msg = document.createElement('p');
    msg.className = 'advla-msg'; msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');

    var row = document.createElement('div');
    row.className = 'advla-row';
    row.appendChild(city); row.appendChild(state);

    form.appendChild(email); form.appendChild(row); form.appendChild(pot); form.appendChild(btn);

    // "Form started" fires once, on the first real interaction with any field.
    var started = false;
    function markStarted() {
      if (started) return;
      started = true;
      track('alert_form_started', { placement: placement });
    }
    [email, city, state].forEach(function (f) {
      f.addEventListener('focus', markStarted, { once: true });
      f.addEventListener('input', markStarted, { once: true });
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = { email: email.value.trim(), city: city.value.trim(), state: state.value };
      msg.className = 'advla-msg';

      if (!v.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) {
        msg.className = 'advla-msg advla-err';
        msg.textContent = 'Please enter a valid email address.';
        track('alert_signup_failed', { placement: placement, reason: 'invalid_email' });
        email.focus();
        return;
      }
      if (!v.city || !v.state) {
        msg.className = 'advla-msg advla-err';
        msg.textContent = 'Please add your city and state so we can find sales near you.';
        track('alert_signup_failed', { placement: placement, reason: 'missing_location' });
        (v.city ? state : city).focus();
        return;
      }

      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = 'Signing you up…';

      var visitorId = null;
      try { visitorId = root.AAPAnalytics && root.AAPAnalytics._getVisitorId ? root.AAPAnalytics._getVisitorId() : null; } catch (e) {}

      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: v.email, city: v.city, state: v.state,
          placement: placement, company_url: pot.value,
          page_path: location.pathname, visitor_id: visitorId,
        }),
      })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          btn.disabled = false; btn.textContent = original;
          if (!res.ok || !res.body || res.body.success !== true) {
            msg.className = 'advla-msg advla-err';
            msg.textContent = (res.body && res.body.message) || 'Something went wrong. Please try again.';
            track('alert_signup_failed', { placement: placement, reason: 'server' });
            return;
          }
          // Remembered so we never pester someone who already said yes.
          writeState({ subscribed: true, subscribedAt: Date.now() });
          msg.className = 'advla-msg advla-ok';
          msg.textContent = res.body.message || "You're in! We'll keep you posted about sales near you.";
          form.querySelectorAll('input,select,button').forEach(function (f) { f.disabled = true; });
          track('alert_signup_succeeded', { placement: placement, state: v.state });
          if (typeof onDone === 'function') setTimeout(onDone, 2200);
        })
        .catch(function () {
          btn.disabled = false; btn.textContent = original;
          msg.className = 'advla-msg advla-err';
          msg.textContent = 'We could not reach Advantage.Bid. Please check your connection and try again.';
          track('alert_signup_failed', { placement: placement, reason: 'network' });
        });
    });

    return { form: form, msg: msg, firstField: email };
  }

  // ── Footer strip ─────────────────────────────────────────────────────────────
  function mountStrip() {
    if (document.querySelector('.advla-strip')) return;
    if (isSuppressedPath()) return;
    if (alreadySubscribed()) return;

    var host = document.querySelector('[data-adv-local-alerts]');
    if (!host) {
      // No explicit mount point: sit just above the page footer, else at the end of the body. BD
      // themes use a .footer element rather than <footer>, so both are tried. Inserting BEFORE the
      // footer (never inside it) avoids inheriting footer typography or column layout.
      var footer = document.querySelector('footer, .footer, #footer');
      host = document.createElement('div');
      if (footer && footer.parentNode) footer.parentNode.insertBefore(host, footer);
      else document.body.appendChild(host);
    }

    injectStyles();
    var wrap = document.createElement('section');
    wrap.className = 'advla-strip';
    wrap.setAttribute('aria-labelledby', 'advla-strip-h');

    var inner = document.createElement('div');
    inner.className = 'advla-in';
    var h = document.createElement('h3');
    h.id = 'advla-strip-h';
    h.textContent = 'Never Miss a Sale Near You Again!';
    var p = document.createElement('p');
    p.textContent = 'Get notified when new estate sales and auctions are added near you.';

    var built = buildForm(resolvePlacement('footer'));
    var fine = document.createElement('p');
    fine.className = 'advla-fine';
    fine.textContent = 'You are asking for local auction and estate-sale notifications. '
      + 'No account needed, and you can unsubscribe from any email.';

    inner.appendChild(h); inner.appendChild(p); inner.appendChild(built.form);
    inner.appendChild(built.msg); inner.appendChild(fine);
    wrap.appendChild(inner);
    host.appendChild(wrap);

    track('alert_offer_shown', { placement: resolvePlacement('footer'), surface: 'strip' });
  }

  // ── Modal ────────────────────────────────────────────────────────────────────
  var modalOpen = false;
  var lastFocus = null;

  function openModal(trigger) {
    if (modalOpen || !modalAllowed()) return;
    modalOpen = true;
    injectStyles();

    var s = readState();
    writeState({ shownAt: Date.now(), shownCount: (s.shownCount || 0) + 1 });
    try { sessionStorage.setItem(SESSION_SHOWN, '1'); } catch (e) {}

    lastFocus = document.activeElement;

    var ov = document.createElement('div');
    ov.className = 'advla-ov';
    var box = document.createElement('div');
    box.className = 'advla-m';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'advla-h');
    box.setAttribute('aria-describedby', 'advla-d');

    var x = document.createElement('button');
    x.type = 'button'; x.className = 'advla-x'; x.innerHTML = '&times;';
    x.setAttribute('aria-label', 'Close');

    var h = document.createElement('h2');
    h.id = 'advla-h'; h.textContent = 'Never Miss a Sale Near You Again!';
    var d = document.createElement('p');
    d.id = 'advla-d'; d.className = 'advla-sub';
    d.textContent = 'Get notified when new estate sales and auctions are added near you.';

    var built = buildForm(resolvePlacement('modal'), close);
    var fine = document.createElement('p');
    fine.className = 'advla-fine';
    fine.textContent = 'You are asking for local auction and estate-sale notifications. '
      + 'No account needed, and you can unsubscribe from any email.';

    var no = document.createElement('button');
    no.type = 'button'; no.className = 'advla-no'; no.textContent = 'No thanks';

    box.appendChild(x); box.appendChild(h); box.appendChild(d);
    box.appendChild(built.form); box.appendChild(built.msg);
    box.appendChild(fine); box.appendChild(no);
    ov.appendChild(box);
    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('open'); });

    function dismiss(how) {
      writeState({ dismissedAt: Date.now() });
      track('alert_modal_dismissed', { trigger: trigger, how: how });
      close();
    }
    function close() {
      if (!modalOpen) return;
      modalOpen = false;
      ov.classList.remove('open');
      setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 180);
      document.removeEventListener('keydown', onKey, true);
      try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
    }

    x.addEventListener('click', function () { dismiss('close_button'); });
    no.addEventListener('click', function () { dismiss('no_thanks'); });
    ov.addEventListener('click', function (ev) { if (ev.target === ov) dismiss('backdrop'); });

    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); dismiss('escape'); return; }
      if (ev.key !== 'Tab') return;
      // Focus trap.
      var f = box.querySelectorAll('button,input,select,a[href]');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    setTimeout(function () { try { built.firstField.focus(); } catch (e) {} }, 60);

    track('alert_modal_shown', { trigger: trigger, viewport: window.innerWidth < 560 ? 'mobile' : 'desktop' });
  }

  // ── Triggers ─────────────────────────────────────────────────────────────────
  function armTriggers() {
    if (!modalAllowed()) return;

    // 1. Engaged dwell. Only counts while the tab is visible AND the visitor has done something
    //    (scrolled, moved, tapped) — a parked background tab is not engagement.
    var engagedMs = 0, interacted = false, last = Date.now(), timer = null;
    function markInteracted() { interacted = true; }
    ['scroll', 'mousemove', 'touchstart', 'keydown', 'click'].forEach(function (e) {
      window.addEventListener(e, markInteracted, { passive: true, once: true });
    });
    function tick() {
      var now = Date.now();
      if (document.visibilityState === 'visible' && interacted) engagedMs += now - last;
      last = now;
      if (engagedMs >= POLICY.engagedMs) {
        clearInterval(timer);
        openModal('engaged_dwell');
      }
    }
    timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', function () { last = Date.now(); });

    // 2. Second event/auction detail viewed in this session.
    if (DETAIL_PATH.test(location.pathname)) {
      var n = 0;
      try { n = parseInt(sessionStorage.getItem(DETAIL_VIEWS) || '0', 10) || 0; } catch (e) {}
      n += 1;
      try { sessionStorage.setItem(DETAIL_VIEWS, String(n)); } catch (e) {}
      if (n >= POLICY.detailViewsToTrigger) {
        // A short beat so it lands after the page has settled, never during load.
        setTimeout(function () { openModal('second_detail_view'); }, 2500);
      }
    }

    // 3. Desktop exit intent. Pointer leaving towards the browser chrome, fine pointer, wide viewport.
    var fine = true;
    try { fine = window.matchMedia('(pointer:fine)').matches; } catch (e) {}
    if (fine && window.innerWidth >= POLICY.exitIntentMinWidth) {
      document.addEventListener('mouseout', function onOut(ev) {
        if (ev.relatedTarget || ev.toElement) return;      // still inside the document
        if ((ev.clientY || 0) > 60) return;                 // only towards the top chrome
        document.removeEventListener('mouseout', onOut);
        openModal('exit_intent');
      });
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  function boot() {
    if (root[ '__advLocalAlertsBooted' ]) return;
    root['__advLocalAlertsBooted'] = true;
    try {
      mountStrip();
      armTriggers();
    } catch (e) { /* never break the page */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Exposed for tests and for a page that wants to place the strip explicitly.
  root.AdvLocalAlerts = {
    _policy: POLICY,
    _suppressed: isSuppressedPath,
    _modalAllowed: modalAllowed,
    _readState: readState,
    open: openModal,
    mountStrip: mountStrip,
    SUPPRESSED_PATHS: SUPPRESSED_PATHS,
  };
})(window);
