/* Shared buyer header/navigation (#6). Self-mounts a sticky top bar with Back,
 * Auctions, My Bids, Watchlist, Account, and a Log in/out affordance. Works on
 * desktop and mobile (links wrap / scroll; no fragile hamburger). Include on any
 * buyer page: <script src="/widgets/shared/buyer-nav.js"></script>
 */
(function () {
  'use strict';
  if (window.__buyerNavInstalled) return;
  window.__buyerNavInstalled = true;

  var CSS =
    '#buyer-nav{position:sticky;top:0;z-index:50;background:#0f172a;color:#fff;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.18)}' +
    '#buyer-nav .bn-inner{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:6px;' +
      'padding:8px 12px;flex-wrap:wrap}' +
    '#buyer-nav .bn-back{background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:7px;' +
      'padding:7px 12px;font-size:14px;font-weight:600;cursor:pointer}' +
    '#buyer-nav .bn-back:hover{background:rgba(255,255,255,.22)}' +
    '#buyer-nav .bn-brand{font-weight:800;color:#fff;text-decoration:none;margin:0 8px 0 4px;font-size:15px;white-space:nowrap}' +
    '#buyer-nav .bn-links{display:flex;align-items:center;gap:2px;flex:1;flex-wrap:wrap;overflow-x:auto}' +
    '#buyer-nav .bn-links a{color:#cbd5e1;text-decoration:none;padding:7px 12px;border-radius:7px;' +
      'font-size:14px;font-weight:600;white-space:nowrap}' +
    '#buyer-nav .bn-links a:hover{background:rgba(255,255,255,.10);color:#fff}' +
    '#buyer-nav .bn-links a.active{background:#2563eb;color:#fff}' +
    '#buyer-nav .bn-auth a{color:#cbd5e1;text-decoration:none;font-size:14px;font-weight:700;padding:7px 10px;white-space:nowrap}' +
    '#buyer-nav .bn-auth a:hover{color:#fff}' +
    '#buyer-nav .bn-sell{opacity:.75;border:1px solid rgba(255,255,255,.22);border-radius:7px;margin-right:6px}' +
    '#buyer-nav .bn-sell:hover{opacity:1}' +
    '#buyer-nav .bn-sound{background:none;border:none;color:#cbd5e1;font-size:16px;cursor:pointer;padding:6px 8px;line-height:1}' +
    '#buyer-nav .bn-sound:hover{color:#fff}' +
    '@media (max-width:600px){#buyer-nav .bn-brand{display:none}#buyer-nav .bn-links a{padding:7px 9px;font-size:13px}}';

  var LINKS = [
    { href: '/', label: 'Auctions', match: ['/', '/index.html'] },
    { href: '/search.html', label: 'Browse Auctions' },
    { href: '/browse-categories.html', label: 'Categories' },
    { href: '/browse-locations.html', label: 'Locations' },
    { href: '/my-bids.html', label: 'My Bids' },
    { href: '/watchlist.html', label: 'Watchlist' },
    { href: '/invoices.html', label: 'Invoices' },
    { href: '/billing.html', label: 'Billing' },
    { href: '/account.html', label: 'Account' },
  ];

  function sameOriginReferrer() {
    try { return document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) { return false; }
  }
  function goBack() {
    if (history.length > 1 && sameOriginReferrer()) history.back();
    else location.href = '/';
  }

  // ── #14 optional bid chime ──────────────────────────────────────────────────
  // OFF by default; persisted in localStorage. Short, rate-limited tone on
  // bid / outbid / extension. WebAudio — no autoplay: the AudioContext is only
  // created/resumed from a user gesture (the toggle) or a live bid event, and
  // nothing plays unless the buyer has explicitly turned sounds on.
  var _audio = null, _lastChime = 0;
  function chimeEnabled() { try { return localStorage.getItem('bidSound') === 'on'; } catch (e) { return false; } }
  function audioCtx() {
    try {
      if (!_audio) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; _audio = new AC(); }
      if (_audio.state === 'suspended' && _audio.resume) _audio.resume();
      return _audio;
    } catch (e) { return null; }
  }
  function beep(freqs) {
    var c = audioCtx(); if (!c) return;
    var t = c.currentTime;
    freqs.forEach(function (f, i) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      var s = t + i * 0.09;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.14, s + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.085);
      o.connect(g); g.connect(c.destination);
      o.start(s); o.stop(s + 0.09);
    });
  }
  function playChime(kind) {
    if (!chimeEnabled()) return;
    var now = Date.now(); if (now - _lastChime < 800) return;   // rate-limit — never spammy
    _lastChime = now;
    if (kind === 'outbid') beep([392]);              // lower single tone
    else if (kind === 'extended') beep([587, 784]);  // rising pair
    else beep([659, 988]);                           // new bid: bright rising pair
  }
  function toggleChime() {
    var on = !chimeEnabled();
    try { localStorage.setItem('bidSound', on ? 'on' : 'off'); } catch (e) {}
    if (on) { audioCtx(); beep([659, 988]); }        // confirmation beep (within the click gesture)
    return on;
  }
  window.BuyerChime = { enabled: chimeEnabled, play: playChime, toggle: toggleChime };

  function mount() {
    if (document.getElementById('buyer-nav')) return;
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

    var token = (function () { try { return localStorage.getItem('token'); } catch (e) { return null; } })();
    var here = location.pathname;
    var linksHtml = LINKS.map(function (l) {
      var active = (l.match ? l.match.indexOf(here) !== -1 : here === l.href);
      return '<a href="' + l.href + '"' + (active ? ' class="active"' : '') + '>' + l.label + '</a>';
    }).join('');

    var authHtml = token
      ? '<a href="#" data-bn-logout>Log out</a>'
      : '<a href="/login.html?next=' + encodeURIComponent(here + location.search) + '">Log in</a>';

    var header = document.createElement('header');
    header.id = 'buyer-nav';
    header.innerHTML =
      '<div class="bn-inner">' +
        '<button class="bn-back" type="button" aria-label="Go back">&#8592; Back</button>' +
        '<a class="bn-brand" href="/">Advantage.Bid</a>' +
        '<nav class="bn-links">' + linksHtml + '</nav>' +
        '<button class="bn-sound" type="button" aria-label="Toggle bid sounds" title="Bid sounds (off by default)"></button>' +
        '<div class="bn-auth"><a href="/start-selling.html" class="bn-sell" title="List items for auction">Sell</a>' + authHtml + '</div>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);

    header.querySelector('.bn-back').addEventListener('click', goBack);
    var logout = header.querySelector('[data-bn-logout]');
    if (logout) logout.addEventListener('click', function (e) {
      e.preventDefault();
      try { localStorage.removeItem('token'); } catch (_) {}
      location.href = '/';
    });

    // #14 bid-sound toggle
    var sound = header.querySelector('.bn-sound');
    if (sound) {
      var paint = function () { sound.textContent = chimeEnabled() ? '🔊' : '🔇'; sound.style.opacity = chimeEnabled() ? '1' : '0.6'; };
      paint();
      sound.addEventListener('click', function () { toggleChime(); paint(); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.BuyerNav = { mount: mount, goBack: goBack };
})();
