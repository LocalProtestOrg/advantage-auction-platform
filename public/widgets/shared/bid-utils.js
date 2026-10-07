/* Shared buyer bid helpers - single source of truth for lot.html and
 * auction-view.html so bid parsing, next-min math, and error wording never drift.
 * Exposes window.BidUtils. All bid CALCULATION here mirrors the server
 * (bidService): minimum next bid = max(starting, current + increment).
 */
(function (global) {
  'use strict';

  // Accept "5", "5.00", "$5", "$5.00", "1,000", "1000.00". Returns a Number or NaN.
  // NEVER rounds — the buyer's exact entry is preserved so the platform can never
  // silently modify a bid amount. Whole-dollar bidding is enforced by REJECTING a
  // fractional entry (see wholeDollarError), not by rounding it.
  function parseMoney(v) {
    if (v == null) return NaN;
    var cleaned = String(v).replace(/[$,\s]/g, '');
    if (cleaned === '') return NaN;
    var n = Number(cleaned);
    return Number.isFinite(n) ? n : NaN;
  }

  // Whole-dollar bidding gate. Returns a buyer-facing error string when the entered
  // dollar amount is missing, non-positive, or contains cents; '' when it is a valid
  // whole-dollar bid. The amount is NEVER altered — an invalid entry is rejected so
  // the buyer can correct it themselves.
  function wholeDollarError(dollars) {
    if (!Number.isFinite(dollars) || dollars <= 0) return 'Enter a bid amount in whole dollars.';
    if (Math.floor(dollars) !== dollars) return 'Enter your bid in whole dollars (no cents).';
    return '';
  }

  // Minimum next bid = max(starting, current + increment). Prefer the server's
  // already-banded increment (effective_bid_increment_cents) when provided; when
  // absent, fall back to the shared platform ladder (bid-increment.js) so the
  // client hint matches bidService exactly. All inputs in cents.
  function nextMinCents(startingCents, currentCents, incrementCents) {
    var s = Number(startingCents);  if (!Number.isFinite(s) || s <= 0) s = 100;
    var c = Number(currentCents);   if (!Number.isFinite(c) || c < 0)  c = 0;
    var i = Number(incrementCents);
    if (!Number.isFinite(i) || i <= 0) {
      i = (global.BidIncrement && global.BidIncrement.incrementForCents)
        ? global.BidIncrement.incrementForCents(c)
        : 500;
    }
    var n = Math.max(s, c + i);
    return (Number.isFinite(n) && n > 0) ? n : s;
  }

  function formatUSD(cents) {
    var c = Number(cents);
    if (!Number.isFinite(c)) c = 0;
    // Whole-dollar bidding: buyers never see cents (backend keeps exact cents).
    return '$' + Math.round(c / 100).toLocaleString('en-US');
  }

  // Map a failed bid response to a clear, human message - never a raw JS error.
  function humanizeBidError(status, serverMsg) {
    if (serverMsg && /^(Bid|Max bid|Your bid|Enter a bid)/i.test(serverMsg)) {
      return serverMsg; // already buyer-friendly, e.g. "Bid must be at least $25.00"
    }
    if (status === 401) return 'Please log in to bid.';
    if (status === 403) return 'This lot is not open for bidding.';
    if (status === 404) return 'This lot could not be found. Please refresh and try again.';
    if (status === 422) return (serverMsg && /closed/i.test(serverMsg)) ? 'This lot has already closed.' : (serverMsg || 'This lot is not accepting bids.');
    return serverMsg || 'Your bid could not be placed. Please refresh and try again.';
  }

  // Build a POST body from raw input strings. Returns { payload, amount, maxDollar,
  // hasAmount, hasMax } or { error } when nothing usable was entered.
  function buildBidPayload(amountStr, maxStr) {
    var amount = parseMoney(amountStr);
    var maxDollar = parseMoney(maxStr);
    var hasMax = Number.isFinite(maxDollar) && maxDollar > 0;
    var hasAmount = Number.isFinite(amount) && amount > 0;
    if (!hasAmount && !hasMax) return { error: 'Enter a bid amount or set a max bid.' };
    // Whole-dollar enforcement — reject (never round) a fractional entry and leave
    // the buyer's typed value in place for correction.
    if (hasAmount) { var ae = wholeDollarError(amount);    if (ae) return { error: ae }; }
    if (hasMax)    { var me = wholeDollarError(maxDollar);  if (me) return { error: me }; }
    var payload = {};
    if (hasAmount) payload.amount = amount;
    if (hasMax) payload.max_bid_cents = Math.round(maxDollar * 100);
    return { payload: payload, amount: amount, maxDollar: maxDollar, hasAmount: hasAmount, hasMax: hasMax };
  }

  // Place a bid. Returns { ok, status, data, message, unauthorized }. Never throws.
  async function placeBid(lotId, payload, token) {
    try {
      var res = await fetch('/api/lots/' + lotId + '/bids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(payload)
      });
      if (res.status === 401) return { ok: false, status: 401, unauthorized: true, message: 'Please log in to bid.' };
      var data = await res.json().catch(function () { return null; });
      if (!res.ok || !data || !data.success) {
        return { ok: false, status: res.status, data: data, message: humanizeBidError(res.status, data && data.message) };
      }
      return { ok: true, status: res.status, data: data.data };
    } catch (e) {
      return { ok: false, status: 0, message: 'Your bid could not be placed. Please check your connection and try again.' };
    }
  }

  // #20: the caller's per-auction bid gate (logged in? terms accepted? registered?).
  async function getBidGate(auctionId, token) {
    if (!token) return { logged_in: false, terms_accepted_current: false, registered: false, can_bid: false };
    try {
      var res = await fetch('/api/auctions/' + auctionId + '/registration-status', { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 401) return { logged_in: false, terms_accepted_current: false, registered: false, can_bid: false };
      var data = await res.json();
      return Object.assign({ logged_in: true }, (data && data.success) ? data.data : {});
    } catch (e) {
      return { logged_in: true, terms_accepted_current: false, registered: false, can_bid: false };
    }
  }

  // #20: register for an auction. Returns { ok, status, message, data }.
  // smsOptIn (optional): { outbid: true, watched_closing: true } - boxes the bidder ticked; never required to register.
  async function registerForAuction(auctionId, token, pickupAcknowledged, smsOptIn) {
    try {
      var res = await fetch('/api/auctions/' + auctionId + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(smsOptIn ? { pickup_acknowledged: !!pickupAcknowledged, sms_opt_in: smsOptIn } : { pickup_acknowledged: !!pickupAcknowledged })
      });
      var data = await res.json().catch(function () { return null; });
      if (res.status === 401) return { ok: false, status: 401, unauthorized: true, message: 'Please log in.' };
      if (!res.ok || !data || !data.success) {
        return { ok: false, status: res.status, code: data && data.code, message: (data && data.message) || 'Registration failed. Please try again.' };
      }
      return { ok: true, status: res.status, data: data.data };
    } catch (e) {
      return { ok: false, status: 0, message: 'Could not register. Please check your connection and try again.' };
    }
  }

  // ── Watchlist / Favorites (shared entry point for lot cards + lot detail) ──────
  // The watchlist already exists (auto-populated when a buyer bids); these give the
  // Auction gallery and Lot Detail a manual add/remove control. All calls are auth'd.
  async function fetchWatchedLotIds(token) {
    if (!token) return new Set();
    try {
      var res = await fetch('/api/watchlist', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return new Set();
      var data = await res.json();
      var arr = (data && data.success && Array.isArray(data.data)) ? data.data : [];
      return new Set(arr.map(function (l) { return String(l.id); }));
    } catch (e) { return new Set(); }
  }
  // watched=true → add, false → remove. Returns { ok, unauthorized }.
  async function setWatched(lotId, watched, token) {
    if (!token) return { ok: false, unauthorized: true };
    try {
      var res = await fetch('/api/watchlist/' + (watched ? 'add' : 'remove'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ lotId: lotId })
      });
      return { ok: res.ok, unauthorized: res.status === 401 };
    } catch (e) { return { ok: false }; }
  }

  global.BidUtils = {
    parseMoney: parseMoney,
    wholeDollarError: wholeDollarError,
    fetchWatchedLotIds: fetchWatchedLotIds,
    setWatched: setWatched,
    nextMinCents: nextMinCents,
    formatUSD: formatUSD,
    humanizeBidError: humanizeBidError,
    buildBidPayload: buildBidPayload,
    placeBid: placeBid,
    getBidGate: getBidGate,
    // Optional text-alert boxes for the registration panel (only when offered and the phone is verified).
    smsOptInBoxes: function (gate) {
      if (!gate || !gate.sms_offer || !gate.sms_offer.offer) return null;
      var wrap = document.createElement('div'); wrap.style.cssText = 'margin:0.4rem 0 0.7rem; font-size:0.82rem; color:#374151;';
      var cur = gate.sms_offer.current || {}; var txt = gate.sms_offer.consent_text || {};
      var head = document.createElement('div'); head.style.cssText = 'font-weight:600; margin-bottom:0.25rem;'; head.textContent = 'Optional text alerts';
      wrap.appendChild(head);
      [['outbid', 'Text me if I am outbid'], ['watched_closing', 'Text me 1 hour before lots begin closing in auctions I watch']].forEach(function (p) {
        if (cur[p[0]]) return;
        var l = document.createElement('label'); l.style.cssText = 'display:flex; gap:0.4rem; align-items:flex-start; margin:0.2rem 0;';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.setAttribute('data-sms', p[0]);
        var sp = document.createElement('span'); sp.textContent = ' ' + p[1]; sp.title = txt[p[0]] || '';
        l.appendChild(cb); l.appendChild(sp); wrap.appendChild(l);
      });
      var fine = document.createElement('div'); fine.style.cssText = 'font-size:0.74rem; color:#6b7280; margin-top:0.2rem;';
      fine.textContent = 'Optional, not required to bid. Message and data rates may apply. Reply STOP to opt out, HELP for help.';
      wrap.appendChild(fine);
      return wrap;
    },
    smsChoices: function (wrap) {
      if (!wrap) return null; var out = {}; var any = false;
      [].forEach.call(wrap.querySelectorAll('input[data-sms]'), function (cb) { if (cb.checked) { out[cb.getAttribute('data-sms')] = true; any = true; } });
      return any ? out : null;
    },
    registerForAuction: registerForAuction
  };
})(window);
