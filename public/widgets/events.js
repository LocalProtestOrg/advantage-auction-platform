/* Advantage.Bid — Local Events embeddable widget (Phase 1).
 *
 * Drop-in for Brilliant Directories city pages (or any site). Renders published events
 * from the Railway public API into a shadow root (CSS-isolated from the host page).
 *
 *   <div data-advantage-events data-market="houston" data-limit="12"></div>
 *   <script async src="https://bid.advantage.bid/widgets/events.js"></script>
 *
 * Data + links resolve to the origin this script is served from (bid.advantage.bid).
 * Read-only; no auth; no host-page globals touched.
 */
(function () {
  'use strict';

  function base() {
    try {
      var s = document.currentScript;
      if (!s) {
        var all = document.querySelectorAll('script[src]');
        for (var i = all.length - 1; i >= 0; i--) { if (/widgets\/events\.js(\?|$)/.test(all[i].src)) { s = all[i]; break; } }
      }
      return new URL(s.src).origin;
    } catch (e) { return 'https://bid.advantage.bid'; }
  }
  var BASE = base();

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(t) { if (!t) return ''; try { return new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
  function badgeClass(b) { b = (b || '').toLowerCase(); return b.indexOf('verified') >= 0 ? 'verified' : b.indexOf('imported') >= 0 ? 'imported' : b.indexOf('advantage') >= 0 ? 'advantage' : 'community'; }

  var STYLE = '@import url("https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap");'
    + ':host{all:initial}*{box-sizing:border-box}'
    + '.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0B1B2B}'
    + '.c{display:flex;flex-direction:column;background:#fff;border:1px solid #ECE8E0;border-radius:16px;overflow:hidden;text-decoration:none;color:inherit;transition:transform .16s,box-shadow .16s}'
    + '.c:hover{transform:translateY(-3px);box-shadow:0 14px 30px rgba(8,16,28,.13)}'
    + '.ph{aspect-ratio:16/10;background:#eef0f3 center/cover no-repeat;position:relative}.none{background:linear-gradient(135deg,#243b6b,#7a274a)}'
    + '.cat{position:absolute;left:9px;top:9px;font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:rgba(8,14,24,.5);border-radius:999px;padding:3px 8px}'
    + '.b{padding:12px 13px 13px;display:flex;flex-direction:column;gap:5px;flex:1}'
    + '.t{font-family:"Fraunces","Georgia",serif;font-weight:600;font-size:16px;line-height:1.18}'
    + '.s{font-size:12.5px;color:#637488}'
    + '.o{margin-top:auto;padding-top:7px;border-top:1px solid #ECE8E0;display:flex;align-items:center;gap:7px;font-size:12px;color:#3a4a5c}'
    + '.bd{font-size:10px;font-weight:800;border-radius:999px;padding:2px 7px}'
    + '.community{background:#eef2f6;color:#475569}.verified{background:rgba(22,163,74,.12);color:#15803d}.imported{background:#fef3c7;color:#92610a}.advantage{background:rgba(181,39,59,.1);color:#B5273B}'
    + '.all{display:inline-block;margin-top:14px;font:600 14px system-ui;color:#2F6BFF;text-decoration:none}'
    + '.msg{grid-column:1/-1;color:#637488;font:14px system-ui;padding:26px 8px;text-align:center}';

  function card(e) {
    var ph = e.cover_image_url ? ('<div class="ph" style="background-image:url(\'' + esc(e.cover_image_url) + '\')">') : '<div class="ph none">';
    var org = e.organization ? e.organization.name : (e.organizer_badge === 'Advantage' ? 'Advantage' : '');
    return '<a class="c" href="' + BASE + '/event.html?slug=' + encodeURIComponent(e.slug) + '">'
      + ph + (e.category ? '<span class="cat">' + esc(e.category.replace(/_/g, ' ')) + '</span>' : '') + '</div>'
      + '<div class="b"><div class="t">' + esc(e.title) + '</div>'
      + '<div class="s">' + fmt(e.start_at) + (e.city ? ' · ' + esc(e.city) + (e.state ? ', ' + esc(e.state) : '') : '') + '</div>'
      + '<div class="o"><span class="bd ' + badgeClass(e.organizer_badge) + '">' + esc(e.organizer_badge || 'Community Organizer') + '</span>'
      + (org ? '<span>' + esc(org) + '</span>' : '') + '</div></div></a>';
  }

  function render(container) {
    var market = container.getAttribute('data-market') || '';
    var category = container.getAttribute('data-category') || '';
    var limit = Math.min(48, Math.max(1, parseInt(container.getAttribute('data-limit'), 10) || 12));
    var root = container.attachShadow ? container.attachShadow({ mode: 'open' }) : container;
    root.innerHTML = '<style>' + STYLE + '</style><div class="g"><div class="msg">Loading events…</div></div>';
    var g = root.querySelector('.g');
    var q = ['limit=' + limit];
    if (market) q.push('market=' + encodeURIComponent(market));
    if (category) q.push('category=' + encodeURIComponent(category));
    fetch(BASE + '/api/public/events?' + q.join('&')).then(function (r) { return r.json(); }).then(function (d) {
      var rows = (d && d.data) || [];
      if (!rows.length) { g.innerHTML = '<div class="msg">No upcoming events right now.</div>'; return; }
      g.innerHTML = rows.map(card).join('');
      var all = document.createElement('a'); all.className = 'all';
      all.href = BASE + '/events.html' + (market ? ('?market=' + encodeURIComponent(market)) : '');
      all.textContent = 'View all events →';
      g.parentNode.appendChild(all);
    }).catch(function () { g.innerHTML = '<div class="msg">Events are unavailable right now.</div>'; });
  }

  function init() {
    var nodes = document.querySelectorAll('[data-advantage-events]');
    Array.prototype.forEach.call(nodes, function (c) { if (c.__abEventsInit) return; c.__abEventsInit = true; render(c); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
