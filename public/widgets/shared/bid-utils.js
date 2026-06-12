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

  // Exact mirror of bidService: minimum next bid = max(starting, current + increment).
  // With no bids (current=0) this is max(starting, increment). All inputs in cents.
  function nextMinCents(startingCents, currentCents, incrementCents) {
    var s = Number(startingCents);  if (!Number.isFinite(s) || s <= 0) s = 100;
    var c = Number(currentCents);   if (!Number.isFinite(c) || c < 0)  c = 0;
    var i = Number(incrementCents); if (!Number.isFinite(i) || i <= 0) i = 500;
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

  global.BidUtils = {
    parseMoney: parseMoney,
    nextMinCents: nextMinCents,
    formatUSD: formatUSD,
    humanizeBidError: humanizeBidError,
    buildBidPayload: buildBidPayload,
    placeBid: placeBid
  };
})(window);
