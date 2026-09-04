/* ============================================================================
   AdvOnsite — first-party onsite personalization renderer. Fetches AT MOST ONE
   treatment for the current page + visitor and renders it into [data-adv-onsite]
   (or does nothing). The page is FULLY functional without it. No surveillance
   copy, no visible tracking references. Requires personalization consent +
   server authorization (both enforced server-side; this client just renders).

   Usage:
     <div data-adv-onsite></div>
     <script src="/widgets/shared/onsite-personalization.js" defer></script>
   ========================================================================== */
(function () {
  'use strict';
  function visitorId() {
    try { if (window.AAPAnalytics && window.AAPAnalytics._getVisitorId) return window.AAPAnalytics._getVisitorId(); } catch (e) {}
    try { return localStorage.getItem('aap_visitor_id'); } catch (e) { return null; }
  }
  function render(mount, t) {
    if (!t) return;   // fallback: no treatment, page unchanged
    var box = document.createElement('div');
    box.setAttribute('role', 'complementary');
    box.style.cssText = 'border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin:16px 0;background:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    var h = document.createElement('div'); h.style.cssText = 'font-weight:700;font-size:15px;color:#0f172a;margin-bottom:4px'; h.textContent = t.headline || '';
    var p = document.createElement('p'); p.style.cssText = 'margin:0 0 10px;font-size:13.5px;color:#475569'; p.textContent = t.body || '';
    var a = document.createElement('a'); a.href = t.cta_href || '#'; a.textContent = t.cta_label || 'Learn more';
    a.style.cssText = 'display:inline-block;background:#2563eb;color:#fff;font-weight:700;font-size:13px;text-decoration:none;padding:8px 14px;border-radius:8px';
    box.appendChild(h); box.appendChild(p); box.appendChild(a);
    mount.appendChild(box);
  }
  function go() {
    var mount = document.querySelector('[data-adv-onsite]');
    if (!mount) return;
    var vid = visitorId();
    if (!vid) return;
    var url = '/api/public/onsite/treatment?visitor_id=' + encodeURIComponent(vid) + '&path=' + encodeURIComponent(location.pathname + location.search);
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.treatment) render(mount, d.treatment); })
      .catch(function () { /* page unaffected */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
