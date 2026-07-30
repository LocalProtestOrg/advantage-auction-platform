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

  // Staleness: reject events that have already ended (keeps the marketplace fresh). Optional (needs now).
  if (typeof opts.now === 'number') {
    const end = Date.parse(c.end_at);
    if (Number.isFinite(end) && end < opts.now) return { ok: false, outcome: 'rejected_quality', reason: 'already_ended' };
  }

  return { ok: true, outcome: 'ok' };
}

module.exports = { validate, hasUsableLocation };
