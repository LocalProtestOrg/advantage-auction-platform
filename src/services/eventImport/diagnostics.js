'use strict';

/**
 * diagnostics — what a connector actually saw on the wire during one run. Pure bookkeeping, no I/O.
 *
 * WHY. Connectors used to swallow a failed page fetch and return nothing, so a source that answered
 * "403 Access Denied" and a source that simply had no upcoming events both ended as the same run:
 * "completed, fetched 0" — three such runs in a row went unexplained before this existed.
 * A connector now records every entry-page response here; the engine turns the tally into an explicit
 * zero-result reason and fails the run when the source refused access.
 *
 *   record(url, status, note?)   status = HTTP status (number) or 'network' / 'timeout' / 'parse'
 *   summary()                    counts by status class + first blocking response
 *   zeroReason(fetched)          why a run produced nothing (null when it produced something)
 *   partner(outcome)             one member feed's result in this run (a multi-member source such as
 *   partners()                   Member Feed Sync must show WHICH partner failed, not only the source)
 */

const BLOCK_STATUSES = new Set([401, 403, 407, 451]);

// One member feed's result: 'ok' (read, items > 0), 'empty' (read, nothing listed), 'blocked',
// 'rate_limited', 'unreachable' or 'parse_failure'. Pure.
function feedOutcome(status, items, parsedSomething) {
  if (BLOCK_STATUSES.has(status)) return 'blocked';
  if (status === 429) return 'rate_limited';
  if (status === 'network' || status === 'timeout' || (typeof status === 'number' && status >= 500)) return 'unreachable';
  if (typeof status === 'number' && (status < 200 || status >= 300)) return 'unreachable';
  if (items > 0) return 'ok';
  return parsedSomething === false ? 'parse_failure' : 'empty';
}

function createDiagnostics() {
  const responses = [];
  const partners = [];
  return {
    record(url, status, note = null) {
      responses.push({ url: String(url || '').slice(0, 300), status, note: note ? String(note).slice(0, 200) : null });
    },
    responses() { return responses.slice(); },
    summary() { return summarize(responses); },
    partner(p) {
      partners.push({ organization_id: p.organization_id || null, organizer_name: p.organizer_name || null,
        feed: String(p.feed || '').slice(0, 300), http: p.http == null ? null : p.http, outcome: p.outcome, items: Number(p.items) || 0,
        note: p.note ? String(p.note).slice(0, 200) : null });
    },
    partners() { return partners.slice(); },
  };
}

/** Counts by class, plus the first blocking / failing response. Pure. */
function summarize(responses = []) {
  const out = { requests: responses.length, ok: 0, blocked: 0, rate_limited: 0, not_found: 0, server_error: 0, network: 0, parse: 0,
    first_block: null, first_error: null };
  for (const r of responses) {
    const s = r.status;
    if (typeof s === 'number' && s >= 200 && s < 300) out.ok++;
    else if (BLOCK_STATUSES.has(s)) { out.blocked++; if (!out.first_block) out.first_block = r; }
    else if (s === 429) { out.rate_limited++; if (!out.first_error) out.first_error = r; }
    else if (s === 404 || s === 410) out.not_found++;
    else if (typeof s === 'number' && s >= 500) { out.server_error++; if (!out.first_error) out.first_error = r; }
    else if (s === 'parse') { out.parse++; if (!out.first_error) out.first_error = r; }
    else { out.network++; if (!out.first_error) out.first_error = r; }
  }
  return out;
}

/**
 * Why did a run produce zero records? Pure. Ordered so the most actionable explanation wins:
 *   blocked_by_source   the source refused automated access (401/403…) — structural, needs review
 *   rate_limited        the source asked us to slow down (429) — transient
 *   source_unreachable  network errors / 5xx — transient
 *   parse_failure       pages loaded but could not be read — possible markup change
 *   source_listed_nothing_current  pages loaded fine and listed nothing current — a genuine lull
 *   no_records          the connector produced nothing and recorded no requests (e.g. static file)
 */
function zeroReason(fetched, s) {
  if (fetched > 0) return null;
  s = s || summarize([]);
  if (s.blocked > 0 && s.ok === 0) return 'blocked_by_source';
  if (s.rate_limited > 0 && s.ok === 0) return 'rate_limited';
  if ((s.network > 0 || s.server_error > 0) && s.ok === 0) return 'source_unreachable';
  // One odd page among many readable ones is noise; a pattern of unreadable pages is a markup change.
  if (s.parse >= 2 || (s.parse > 0 && s.parse * 2 >= s.ok)) return 'parse_failure';
  if (s.ok > 0) return 'source_listed_nothing_current';
  return 'no_records';
}

/** Zero-result reasons that mean the run FAILED rather than found nothing. */
const FAILING_ZERO_REASONS = Object.freeze(['blocked_by_source', 'rate_limited', 'source_unreachable', 'parse_failure']);
/** Of those, the ones worth retrying automatically; the rest fail closed until reviewed. */
const TRANSIENT_ZERO_REASONS = Object.freeze(['rate_limited', 'source_unreachable']);

/** Classify a thrown connector error into the same vocabulary. Pure. */
function classifyError(message) {
  const m = String(message || '');
  if (/\bHTTP (401|403|407|451)\b/.test(m)) return { zero_reason: 'blocked_by_source', transient: false };
  if (/\bHTTP 429\b/.test(m)) return { zero_reason: 'rate_limited', transient: true };
  if (/\bHTTP 5\d\d\b|timeout|timed out|abort|ECONN|ENOTFOUND|EAI_AGAIN|socket|fetch failed|network/i.test(m)) return { zero_reason: 'source_unreachable', transient: true };
  if (/parse|JSON|Unexpected token|content-type/i.test(m)) return { zero_reason: 'parse_failure', transient: false };
  return { zero_reason: 'connector_error', transient: false };
}

/** Feed outcomes worth an automatic (bounded) retry. */
const TRANSIENT_FEED_OUTCOMES = Object.freeze(['rate_limited', 'unreachable']);

module.exports = { createDiagnostics, summarize, zeroReason, classifyError, feedOutcome, BLOCK_STATUSES, FAILING_ZERO_REASONS,
  TRANSIENT_ZERO_REASONS, TRANSIENT_FEED_OUTCOMES };
