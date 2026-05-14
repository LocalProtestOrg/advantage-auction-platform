/**
 * marketplace-components.js
 * Shared utilities for Advantage.Bid public marketplace pages.
 * Exposes window.MktComponents and auto-inits on DOMContentLoaded.
 */
(function (root) {
  'use strict';

  /* ── Formatters ─────────────────────────────────────────────────────── */

  function fmtMoney(cents) {
    if (cents == null) return '$0';
    return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  function fmtCountdown(iso) {
    if (!iso) return '';
    var ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'Closed';
    var totalMin = Math.floor(ms / 60000);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    if (h >= 48) { var d = Math.floor(h / 24); return d + 'd ' + (h % 24) + 'h remaining'; }
    if (h >= 1)  return h + 'h ' + m + 'm remaining';
    return m + 'm remaining';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /* ── Predicates ──────────────────────────────────────────────────────── */

  function isEndingSoon(iso) {
    if (!iso) return false;
    var ms = new Date(iso) - Date.now();
    return ms > 0 && ms < 86400000;
  }

  function isNew(createdAt) {
    if (!createdAt) return false;
    return (Date.now() - new Date(createdAt)) < 7 * 86400000;
  }

  function urgencyClass(iso) {
    if (!iso) return '';
    var ms = new Date(iso) - Date.now();
    if (ms <= 0)         return '';
    if (ms < 7200000)   return 'timer-urgent';
    if (ms < 21600000)  return 'timer-ending';
    return '';
  }

  /* ── DOM helpers ─────────────────────────────────────────────────────── */

  function setElem(parent, tag, cls, text) {
    var el = document.createElement(tag);
    if (cls)      el.className   = cls;
    if (text != null) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  /* ── Auction card ────────────────────────────────────────────────────── */

  /**
   * makeAuctionCard(auction, opts)
   * opts.featuredBadge  — show "⭐ Featured" badge instead of state badges
   */
  function makeAuctionCard(auction, opts) {
    opts = opts || {};

    var a = document.createElement('a');
    a.className = 'auction-card';
    a.href = '/auction-view.html?id=' + encodeURIComponent(auction.id);

    /* image */
    var imgDiv = document.createElement('div');
    imgDiv.className = 'auction-card-img';
    if (auction.cover_image_url) {
      imgDiv.style.backgroundImage = 'url(' + encodeURI(auction.cover_image_url) + ')';
    }

    /* badges */
    var badges = document.createElement('div');
    badges.className = 'auction-badges';

    if (opts.featuredBadge) {
      setElem(badges, 'span', 'auction-badge badge-featured', '⭐ Featured');
    } else if (auction.end_time) {
      var ms = new Date(auction.end_time) - Date.now();
      if (ms > 0 && ms < 7200000)    setElem(badges, 'span', 'auction-badge badge-urgent',   '🔴 Closing Now');
      else if (ms > 0 && ms < 86400000)  setElem(badges, 'span', 'auction-badge badge-ending',  '⏱ Closing Today');
      else if (ms >= 86400000 && ms < 172800000) setElem(badges, 'span', 'auction-badge badge-tomorrow', 'Closing Tomorrow');
      else if (ms > 0)               setElem(badges, 'span', 'auction-badge badge-live',    '● Live Now');
    } else if (auction.state === 'published') {
      setElem(badges, 'span', 'auction-badge badge-upcoming', 'Upcoming');
      if (isNew(auction.created_at)) {
        setElem(badges, 'span', 'auction-badge badge-new', 'New');
      }
    }

    if (auction.shipping_available) {
      setElem(badges, 'span', 'auction-badge badge-shipping', '📦 Ships');
    }
    imgDiv.appendChild(badges);

    if (auction.public_auction_type) {
      setElem(imgDiv, 'div', 'auction-card-type-tag', auction.public_auction_type);
    }

    a.appendChild(imgDiv);

    /* body */
    var body = document.createElement('div');
    body.className = 'auction-card-body';

    if (auction.seller_display_name) {
      setElem(body, 'div', 'auction-card-seller', auction.seller_display_name);
    }
    setElem(body, 'div', 'auction-card-title', auction.title || 'Untitled Auction');
    if (auction.city || auction.address_state) {
      setElem(body, 'div', 'auction-card-location',
        [auction.city, auction.address_state].filter(Boolean).join(', '));
    }

    /* meta row */
    var meta = document.createElement('div');
    meta.className = 'auction-card-meta';

    var lc = auction.lot_count || 0;
    setElem(meta, 'span', '', lc + (lc === 1 ? ' lot' : ' lots'));

    if (auction.end_time) {
      var timer = document.createElement('span');
      var uc = urgencyClass(auction.end_time);
      timer.className = 'auction-card-timer' + (uc ? ' ' + uc : '');
      timer.setAttribute('data-closes', auction.end_time);
      timer.textContent = fmtCountdown(auction.end_time);
      meta.appendChild(timer);
    } else if (auction.start_time) {
      setElem(meta, 'span', '', 'Opens ' + fmtDate(auction.start_time));
    }

    body.appendChild(meta);
    a.appendChild(body);
    return a;
  }

  /* ── Skeleton loader ─────────────────────────────────────────────────── */

  function renderSkeletons(container, count) {
    for (var i = 0; i < count; i++) {
      var s   = document.createElement('div'); s.className = 'skeleton-card'; s.setAttribute('aria-hidden', 'true');
      var si  = document.createElement('div'); si.className  = 'sk-img';          s.appendChild(si);
      var sl1 = document.createElement('div'); sl1.className = 'sk-line sk-title'; s.appendChild(sl1);
      var sl2 = document.createElement('div'); sl2.className = 'sk-line sk-sub';   s.appendChild(sl2);
      var sl3 = document.createElement('div'); sl3.className = 'sk-line sk-short'; s.appendChild(sl3);
      container.appendChild(s);
    }
  }

  /* ── Timer tick ──────────────────────────────────────────────────────── */

  function updateTimers() {
    document.querySelectorAll('[data-closes]').forEach(function (el) {
      var iso = el.getAttribute('data-closes');
      el.textContent = fmtCountdown(iso);
      var uc = urgencyClass(iso);
      el.classList.toggle('timer-urgent',  uc === 'timer-urgent');
      el.classList.toggle('timer-ending',  uc === 'timer-ending');
    });
  }

  /* ── Mobile menu ─────────────────────────────────────────────────────── */

  function initMobileMenu() {
    var btn = document.querySelector('.mobile-menu-btn');
    var nav = document.querySelector('.header-nav');
    if (!btn || !nav) return;

    btn.addEventListener('click', function () {
      var open = nav.classList.toggle('mobile-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    /* close on outside click */
    document.addEventListener('click', function (e) {
      if (!nav.contains(e.target) && !btn.contains(e.target)) {
        nav.classList.remove('mobile-open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ── Active nav ──────────────────────────────────────────────────────── */

  function initActiveNav() {
    var path = root.location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('.header-nav .nav-link').forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href) return;
      var linkPath = href.split('?')[0].replace(/\/$/, '') || '/';
      if (linkPath === path) {
        link.classList.add('active');
        link.setAttribute('aria-current', 'page');
      }
    });
  }

  /* ── Auto-init ───────────────────────────────────────────────────────── */

  function init() {
    initMobileMenu();
    initActiveNav();
    setInterval(updateTimers, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ── Public API ──────────────────────────────────────────────────────── */

  root.MktComponents = {
    fmtMoney:        fmtMoney,
    fmtCountdown:    fmtCountdown,
    fmtDate:         fmtDate,
    isEndingSoon:    isEndingSoon,
    isNew:           isNew,
    urgencyClass:    urgencyClass,
    setElem:         setElem,
    makeAuctionCard: makeAuctionCard,
    renderSkeletons: renderSkeletons,
    updateTimers:    updateTimers,
    initMobileMenu:  initMobileMenu,
    initActiveNav:   initActiveNav
  };

}(window));
