'use strict';

/**
 * validate — quality gates for a sanitized CanonicalEvent (§5.4, §8, §16 of the plan). Pure; no DB.
 *
 * A record must have: a title, a start_at, a usable location (so it can be placed + market-resolved),
 * a sane date range, and — critically — a computable end_at (never-expire guard). Optionally it is
 * rejected as stale if it has already ended at import time (we maintain a rolling FRESH inventory).
 *
 * Returns { ok, outcome, reason }: outcome 'ok' when publishable, else 'rejected_quality' with a reason.
 */

function hasUsableLocation(c) {
  return !!((c.city && c.state) || c.zip || (c.lat != null && c.lng != null));
}

const MAX_EVENT_DAYS = 120;
const TEST_TITLE = /\b(test|practice|demo|sample|dummy)\s+(auction|sale|event|listing)\b/i;
const TEST_BODY = /\b(this is a test (auction|sale|listing)|there are no (actual )?items for sale|no actual items)\b/i;

/** The host itself marks this as a practice / test listing. Pure. */
function isTestListing(c) {
  return TEST_TITLE.test(String(c.title || '')) || TEST_BODY.test(String(c.description || ''));
}

function validate(c, opts) {
  opts = opts || {};
  c = c || {};

  const missing = [];
  if (!c.title) missing.push('title');
  if (!c.start_at) missing.push('start_at');
  if (!hasUsableLocation(c)) missing.push('location');
  if (missing.length) return { ok: false, outcome: 'rejected_quality', reason: 'missing:' + missing.join(',') };

  // Date sanity.
  if (c.end_at && c.start_at && c.end_at < c.start_at) return { ok: false, outcome: 'rejected_quality', reason: 'end_before_start' };

  // The never-expire guard: an event with no computable end_at is NEVER published.
  if (!c.end_at) return { ok: false, outcome: 'rejected_quality', reason: 'no_computable_end_at' };

  // Not a real event: a host's own practice / test listing ("TEST AUCTION FOR BIDDERS … There are no
  // actual items for sale") is real on the source but is not a sale a buyer can attend.
  if (isTestListing(c)) return { ok: false, outcome: 'rejected_quality', reason: 'not_a_real_event:test_listing' };

  // Implausible duration: auctions and estate sales run for days or weeks, not years. A span beyond
  // this is a placeholder date on the source (e.g. 2022 → 2031), never a real sale window.
  if (c.start_at && c.end_at) {
    const days = (Date.parse(c.end_at) - Date.parse(c.start_at)) / 86400000;
    if (Number.isFinite(days) && days > MAX_EVENT_DAYS) return { ok: false, outcome: 'rejected_quality', reason: 'implausible_duration' };
  }

  // Staleness: reject events that have already ended (keeps the marketplace fresh). Optional (needs now).
  if (typeof opts.now === 'number') {
    const end = Date.parse(c.end_at);
    if (Number.isFinite(end) && end < opts.now) return { ok: false, outcome: 'rejected_quality', reason: 'already_ended' };
  }

  return { ok: true, outcome: 'ok' };
}

module.exports = { validate, hasUsableLocation, isTestListing, MAX_EVENT_DAYS };
