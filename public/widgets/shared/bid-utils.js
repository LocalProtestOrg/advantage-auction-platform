/* Shared buyer bid helpers — single source of truth for lot.html and
 * auction-view.html so bid parsing, next-min math, and error wording never drift.
 * Exposes window.BidUtils. All bid CALCULATION here mirrors the server
 * (bidService): minimum next bid = max(starting, current + increment).
 */
(function (global) {
  'use strict';

  // Accept "5", "5.00", "$5", "$5.00", "1,000", "1000.00". Returns a Number or NaN.
  function parseMoney(v) {
    if (v == null) return NaN;
    var cleaned = String(v).replace(/[$,\s]/g, '');
    if (cleaned === '') return NaN;
    var n = Number(cleaned);
    return Number.isFinite(n) ? n : NaN;
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
    return '$' + (c / 100).toFixed(2);
  }

  // Map a failed bid response to a clear, human message — never a raw JS error.
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
  async function registerForAuction(auctionId, token, pickupAcknowledged) {
    try {
      var res = await fetch('/api/auctions/' + auctionId + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ pickup_acknowledged: !!pickupAcknowledged })
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

  global.BidUtils = {
    parseMoney: parseMoney,
    nextMinCents: nextMinCents,
    formatUSD: formatUSD,
    humanizeBidError: humanizeBidError,
    buildBidPayload: buildBidPayload,
    placeBid: placeBid,
    getBidGate: getBidGate,
    registerForAuction: registerForAuction
  };
})(window);
