/* ============================================================================
   AdvConsent — STUPID EASY first-party consent banner. Plain language, no dark
   patterns, advertising NEVER pre-checked, essential always on, easy withdrawal.
   Stores choices in localStorage (aap_consent) so the first-party tracker can
   read them, and mirrors them server-side (/api/public/consent). The site is
   fully usable without granting anything beyond essential.

   Include on public pages:
     <script src="/widgets/shared/consent-banner.js" defer></script>
   ========================================================================== */
(function () {
  'use strict';
  var KEY = 'aap_consent';
  var POLICY = 'v1';

  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || 'null'); return (v && v.policy_version === POLICY) ? v : null; }
    catch (e) { return null; }
  }
  function visitorId() {
    // Reuse AAPAnalytics' durable visitor id if present; else a local fallback.
    try { if (window.AAPAnalytics && window.AAPAnalytics._getVisitorId) return window.AAPAnalytics._getVisitorId(); } catch (e) {}
    try { return localStorage.getItem('aap_visitor_id') || null; } catch (e) { return null; }
  }
  function save(state) {
    state.policy_version = POLICY;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    try {
      fetch('/api/public/consent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ visitor_id: visitorId(), categories: {
          analytics: state.analytics ? 'granted' : 'denied',
          personalization: state.personalization ? 'granted' : 'denied',
          advertising: state.advertising ? 'granted' : 'denied',
        } }),
      }).catch(function () {});
    } catch (e) {}
    // Expose for the tracker immediately.
    window.__ADV_CONSENT = { analytics: !!state.analytics, personalization: !!state.personalization, advertising: !!state.advertising, policy_version: POLICY };
  }

  function styles() {
    if (document.getElementById('adv-consent-styles')) return;
    var css =
      '.adv-consent{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:720px;margin:0 auto;background:#fff;border:1px solid #d7dde5;border-radius:12px;box-shadow:0 10px 30px rgba(8,16,28,.18);padding:14px 16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a}'
      + '.adv-consent p{margin:0 0 10px;font-size:13.5px;line-height:1.5;color:#334155}'
      + '.adv-consent .opts{display:flex;gap:14px;flex-wrap:wrap;margin:0 0 12px;font-size:13px}'
      + '.adv-consent label{display:flex;align-items:center;gap:6px;color:#334155}'
      + '.adv-consent .btns{display:flex;gap:8px;flex-wrap:wrap}'
      + '.adv-consent button{padding:8px 14px;font-size:13px;font-weight:700;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;cursor:pointer}'
      + '.adv-consent button.primary{background:#0f172a;color:#fff;border-color:#0f172a}'
      + '.adv-consent a{color:#2563eb}';
    var s = document.createElement('style'); s.id = 'adv-consent-styles'; s.appendChild(document.createTextNode(css));
    document.head.appendChild(s);
  }

  function render() {
    styles();
    var wrap = document.createElement('div');
    wrap.className = 'adv-consent'; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Privacy choices');
    wrap.innerHTML =
      '<p>We use essential cookies to run Advantage.Bid. With your choice, we also use first-party analytics, on-site personalization, and (only if you allow) advertising measurement. You can change this anytime on our <a href="/privacy.html">Privacy</a> page. Essential features work either way.</p>'
      + '<div class="opts">'
      + '<label><input type="checkbox" checked disabled> Essential (always on)</label>'
      + '<label><input type="checkbox" id="ac-an"> Analytics</label>'
      + '<label><input type="checkbox" id="ac-pe"> Personalization</label>'
      + '<label><input type="checkbox" id="ac-ad"> Advertising</label>'
      + '</div>'
      + '<div class="btns">'
      + '<button class="primary" id="ac-accept">Accept all</button>'
      + '<button id="ac-reject">Reject non-essential</button>'
      + '<button id="ac-save">Save preferences</button>'
      + '</div>';
    document.body.appendChild(wrap);
    var close = function () { try { wrap.remove(); } catch (e) { wrap.style.display = 'none'; } };
    document.getElementById('ac-accept').onclick = function () { save({ analytics: true, personalization: true, advertising: true }); close(); };
    document.getElementById('ac-reject').onclick = function () { save({ analytics: false, personalization: false, advertising: false }); close(); };
    document.getElementById('ac-save').onclick = function () {
      save({ analytics: document.getElementById('ac-an').checked, personalization: document.getElementById('ac-pe').checked, advertising: document.getElementById('ac-ad').checked });
      close();
    };
  }

  // Publish existing choice for the tracker; show the banner only if no valid choice yet.
  var existing = read();
  if (existing) { window.__ADV_CONSENT = existing; return; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
