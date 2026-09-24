'use strict';

/**
 * sourceHealth — per-source health state, bounded retry and circuit breaking. Pure; the worker
 * persists the result on import_sources.
 *
 * CLASSIFICATION (one per source, with a plain-English reason):
 *   HEALTHY            last run succeeded and the source is producing current events
 *   DEGRADED           working but weak: a transient failure awaiting retry, repeated zero-result runs
 *                      after previously producing, or a high rejection rate
 *   BROKEN             3+ consecutive failures, or pages load but cannot be parsed (markup change)
 *   BLOCKED_BY_SOURCE  the source refuses automated access (401/403). Never evaded — needs a person
 *   NO_LONGER_USEFUL   static / frozen input that can never produce a new current event
 *   NEEDS_REVIEW       paused or unconfigured (e.g. member feeds with no feed URLs yet)
 *   RETIRED            deliberately decommissioned (config.retired_reason); kept only as history —
 *                      never a live source, never an action item, never part of inventory health
 *
 * RETRY POLICY (bounded, never a loop): only TRANSIENT failures (network, 5xx, 429) are retried, at
 * 1h, 2h then 4h after the failure — at most MAX_RETRIES per scheduled window. Structural failures
 * (blocked, parse failure) are never retried automatically; the source is re-attempted only at its
 * next scheduled window, which is also how a recovered source closes the circuit again.
 */

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 60 * 60 * 1000;
const BROKEN_AFTER_FAILURES = 3;
const DEGRADED_AFTER_ZERO_RUNS = 3;

const STATES = Object.freeze(['HEALTHY', 'DEGRADED', 'BROKEN', 'BLOCKED_BY_SOURCE', 'NO_LONGER_USEFUL', 'NEEDS_REVIEW', 'RETIRED']);

/**
 * Fold one run's result into the source's persisted health. Pure.
 *   prev:   { consecutive_failures, consecutive_zero_runs, retry_count, last_success_at, last_nonzero_at }
 *   run:    { ok, status, fetched, created, updated, eligible, rejected, zero_reason, transient, error, trigger }
 */
function nextState(prev, run, now = new Date()) {
  prev = prev || {};
  const t = now instanceof Date ? now : new Date(now);
  const failed = run.ok === false || run.status === 'failed';
  const out = {
    consecutive_failures: failed ? (Number(prev.consecutive_failures) || 0) + 1 : 0,
    consecutive_zero_runs: !failed && !(run.fetched > 0) ? (Number(prev.consecutive_zero_runs) || 0) + 1 : 0,
    last_success_at: failed ? prev.last_success_at || null : t.toISOString(),
    last_nonzero_at: !failed && run.fetched > 0 ? t.toISOString() : prev.last_nonzero_at || null,
    last_failure_at: failed ? t.toISOString() : prev.last_failure_at || null,
    last_error: failed ? String(run.error || run.zero_reason || 'failed').slice(0, 400) : null,
    retry_count: 0,
    next_retry_at: null,
  };
  if (failed && run.transient) {
    // A retry run that fails again consumes one retry; a fresh scheduled failure starts the budget.
    const used = run.trigger === 'retry' ? (Number(prev.retry_count) || 0) + 1 : 0;
    if (used < MAX_RETRIES) {
      out.retry_count = used;
      out.next_retry_at = new Date(t.getTime() + RETRY_BASE_MS * Math.pow(2, used)).toISOString();
    } else out.retry_count = used;
  }
  return out;
}

/**
 * Classify a source. Pure.
 *   source: { status, kind, config }   state: persisted health fields   last: latest run { zero_reason, fetched, created, rejected, eligible }
 */
function classify(source, state, last) {
  source = source || {}; state = state || {}; last = last || {};
  const config = source.config || {};
  if (config.retired_reason) return { state: 'RETIRED', reason: config.retired_reason };
  if (config.frozen_reason || (source.kind === 'csv' && last.fetched > 0 && !(last.created > 0) && state.frozen)) {
    return { state: 'NO_LONGER_USEFUL', reason: config.frozen_reason || 'static input with no current events' };
  }
  if (source.status !== 'active') {
    if (config.frozen_reason) return { state: 'NO_LONGER_USEFUL', reason: config.frozen_reason };
    return { state: 'NEEDS_REVIEW', reason: source.status === 'paused' ? (config.paused_reason || 'paused — awaiting configuration or an Owner decision') : 'source is ' + source.status };
  }
  if (last.zero_reason === 'blocked_by_source') {
    return { state: 'BLOCKED_BY_SOURCE', reason: 'the source refuses automated access' + (state.last_error ? ' (' + state.last_error + ')' : '') + ' — not evaded; needs the source\'s permission or a feed' };
  }
  if (last.zero_reason === 'parse_failure') return { state: 'BROKEN', reason: 'pages load but cannot be parsed — possible markup change' };
  if ((Number(state.consecutive_failures) || 0) >= BROKEN_AFTER_FAILURES) {
    return { state: 'BROKEN', reason: state.consecutive_failures + ' consecutive failed runs: ' + (state.last_error || 'unknown error') };
  }
  if ((Number(state.consecutive_failures) || 0) > 0) {
    return { state: 'DEGRADED', reason: 'last run failed (' + (state.last_error || 'error') + ')' + (state.next_retry_at ? '; automatic retry scheduled' : '') };
  }
  if ((Number(state.consecutive_zero_runs) || 0) >= DEGRADED_AFTER_ZERO_RUNS && state.last_nonzero_at) {
    return { state: 'DEGRADED', reason: state.consecutive_zero_runs + ' consecutive runs found nothing current (last produced ' + String(state.last_nonzero_at).slice(0, 10) + ')' };
  }
  const judged = (Number(last.eligible) || 0) + (Number(last.rejected) || 0);
  if (judged >= 5 && (Number(last.rejected) || 0) / judged > 0.5) {
    return { state: 'DEGRADED', reason: 'more than half of fetched events were rejected in the last run' };
  }
  return { state: 'HEALTHY', reason: last.fetched > 0 ? 'last run fetched ' + last.fetched + ' current events' : 'last run succeeded' };
}

/** Is a source due an automatic retry right now? Pure. */
function retryDue(source, state, now = new Date()) {
  if (!source || source.status !== 'active' || !state || !state.next_retry_at) return false;
  return new Date(state.next_retry_at).getTime() <= (now instanceof Date ? now : new Date(now)).getTime();
}

module.exports = { STATES, MAX_RETRIES, RETRY_BASE_MS, BROKEN_AFTER_FAILURES, DEGRADED_AFTER_ZERO_RUNS, nextState, classify, retryDue };
