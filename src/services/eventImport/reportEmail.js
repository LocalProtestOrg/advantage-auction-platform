'use strict';

/**
 * reportEmail — pure builders for the owner-facing Event Import emails. Kept side-effect-free (no mailer)
 * so the classification is unit-testable.
 *
 * Two distinct messages, deliberately separated so "no new events" is never mistaken for a failure:
 *   1) buildRunSummaryEmail(summary) — sent AFTER each scheduled cycle. Subject states exactly what
 *      happened: SUCCESS / NO NEW EVENTS / PARTIAL FAILURE / FAILED, with a discovered/new/updated/
 *      unchanged/rejected/failed breakdown and a per-source line (+ concise reason on failure).
 *   2) emailableCriticals(alerts) — the health monitor emails ONLY genuine pipeline-failure alerts.
 *      Inventory-below-an-aspirational-target is NOT a pipeline failure: a healthy importer that has
 *      simply exhausted the currently-available compliant supply must not generate a daily "failure"
 *      alarm. That signal stays logged/audited and shown in the run summary, but does not email daily.
 */

// Alert codes that mean the PIPELINE is actually broken (worth a critical email). NOTE: 'auctions_critical'
// / 'auctions_below_target' (inventory below the aspirational target) are intentionally excluded.
const PIPELINE_FAILURE_CODES = new Set([
  'missed_window',       // a scheduled window passed with no successful run since
  'stale_import',        // fixed-window fallback (daily/legacy modes) — no success in the stale window
  'run_failed',          // the last import run ended in status 'failed'
  'low_total_inventory', // total active public events fell below the conservative floor (pipeline collapse)
  'scheduler_down',      // reserved: scheduler not evaluating
]);

function emailableCriticals(alerts) {
  return (Array.isArray(alerts) ? alerts : []).filter(
    (a) => a && a.level === 'critical' && PIPELINE_FAILURE_CODES.has(a.code));
}

// Classify a scheduled-cycle summary into the four owner-facing states.
function classifyRun(summary) {
  const s = summary || {}, c = s.counts || {};
  const total = s.sources_total || 0, failed = s.sources_failed || 0;
  if (total > 0 && failed >= total) return 'FAILED';           // every source failed
  if (failed > 0) return 'PARTIAL FAILURE';                    // some sources failed, others ran
  if ((c.imported || 0) > 0 || (c.updated || 0) > 0) return 'SUCCESS'; // real new/updated events
  return 'NO NEW EVENTS';                                      // healthy run, nothing new to add
}

function sumFetched(sources) {
  return (Array.isArray(sources) ? sources : []).reduce((n, x) => n + ((x.counters && x.counters.fetched) || 0), 0);
}

// A concise, owner-readable failure reason (never a stack trace).
function conciseReason(err) {
  if (!err) return '';
  const s = String(err);
  if (/\b403\b/.test(s)) return 'HTTP 403 (blocked)';
  if (/\b401\b/.test(s)) return 'HTTP 401 (unauthorized)';
  if (/\b429\b/.test(s)) return 'HTTP 429 (rate limited)';
  if (/\b5\d\d\b/.test(s)) return 'source server error';
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(s)) return 'timeout';
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(s)) return 'source unreachable';
  if (/parse|JSON|unexpected token/i.test(s)) return 'parser/format error';
  return s.slice(0, 100);
}

function perSourceLine(x) {
  const c = x.counters || {};
  const rejected = (c.skipped_quality || 0) + (c.skipped_ambiguous || 0);
  if (x.ok === false) return `  • ${x.source}: FAILED — ${conciseReason(x.error) || 'error'}`;
  const bits = [`fetched ${c.fetched || 0}`, `new ${c.created || 0}`, `updated ${c.updated || 0}`,
    `unchanged ${c.skipped_duplicate || 0}`];
  if (rejected) bits.push(`rejected ${rejected}`);
  if (c.failed) bits.push(`failed ${c.failed}`);
  if (x.capped) bits.push('weekly cap reached');
  return `  • ${x.source}: ${bits.join(', ')}`;
}

// Build { subject, text } for the per-run summary email.
function buildRunSummaryEmail(summary) {
  const s = summary || {}, c = s.counts || {};
  const state = classifyRun(s);
  const discovered = sumFetched(s.sources);
  const rejected = (s.sources || []).reduce((n, x) => n + (((x.counters || {}).skipped_quality || 0) + ((x.counters || {}).skipped_ambiguous || 0)), 0);
  const durationMin = s.duration_ms != null ? (s.duration_ms / 60000).toFixed(1) : '?';
  const subject = `Advantage.Bid Event Import — ${state}`;
  const lines = [
    `Event import run: ${state}`,
    '',
    `Run: ${s.started_at || '?'} → ${s.finished_at || '?'}  (${durationMin} min)`,
    `Sources: ${s.sources_total || 0} attempted · ${s.sources_ok || 0} ok · ${s.sources_failed || 0} failed`,
    '',
    `Discovered:        ${discovered}`,
    `New imported:      ${c.imported || 0}`,
    `Existing updated:  ${c.updated || 0}`,
    `Unchanged/dupes:   ${c.duplicates || 0}`,
    `Rejected:          ${rejected}`,
    `Failed:            ${c.errors || 0}`,
    '',
    'Per source:',
    ...(s.sources || []).map(perSourceLine),
    '',
    state === 'NO NEW EVENTS'
      ? 'This is a healthy run — the importer reached every source and found no genuinely new qualifying events (everything was already known). No action needed.'
      : (state === 'SUCCESS' ? 'New and/or updated events were imported successfully.'
        : (state === 'PARTIAL FAILURE' ? 'Some sources failed; the others were processed normally. See the per-source reasons above.'
          : 'All sources failed this run — see the per-source reasons above. The next scheduled window will retry.')),
    '',
    'Detailed per-record logs and provenance are in the import run ledger (Admin → Event Import).',
  ];
  return { subject, text: lines.join('\n') };
}

module.exports = { PIPELINE_FAILURE_CODES, emailableCriticals, classifyRun, buildRunSummaryEmail, conciseReason };
