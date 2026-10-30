'use strict';

/**
 * findingsStore — de-duplicated watchdog findings (migration 210).
 *
 * One row per stable dedupe key: check id + problem code + the specific thing affected (a page, a viewport, a URL).
 * Detail text can change between runs (timings, counts); the key does not, so a lasting problem is ONE finding whose
 * occurrences grow, not a new alert every 15 minutes.
 *
 * Lifecycle (per check that actually ran, i.e. status 'ok' or 'fail'; a 'skipped' check changes nothing):
 *   new problem              → INSERT open; needs_alert when critical/high
 *   still there              → occurrences + 1, last_seen_at, latest detail/evidence (no new alert)
 *   gone (check passes)      → resolved, resolved_at
 *   back after being resolved→ re-opened (reopened_count + 1); needs_alert again when critical/high
 */

const { severityFor, alertable } = require('./registry');

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/** The stable identity of one problem. */
function dedupeKey(checkId, issue) {
  const e = issue.evidence || {};
  const what = e.key || e.page || e.url || '';
  const view = e.viewport || '';
  return clip([checkId, issue.code, what, view].join('|'), 500);
}

/**
 * Record one check's outcome. `check` = { id, feature, tier }, `outcome` = { status, issues, reproduce }.
 * Returns { opened, reopened, resolved, alerting } counts.
 */
async function recordCheck(db, { runId = null, source = 'server', check, outcome, now = new Date() }) {
  const stats = { opened: 0, reopened: 0, resolved: 0, alerting: 0 };
  const status = outcome && outcome.status;
  await db.query(
    `INSERT INTO watchdog_check_state (check_id, last_run_at, last_status, last_duration_ms, consecutive_failures)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'fail' THEN 1 ELSE 0 END)
     ON CONFLICT (check_id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_status = EXCLUDED.last_status,
       last_duration_ms = EXCLUDED.last_duration_ms,
       consecutive_failures = CASE WHEN EXCLUDED.last_status = 'fail' THEN watchdog_check_state.consecutive_failures + 1 ELSE 0 END`,
    [check.id, now, status || 'error', outcome && outcome.durationMs != null ? Math.round(outcome.durationMs) : null]);
  if (status !== 'ok' && status !== 'fail') return stats;          // skipped: nothing to judge

  const seen = new Set();
  for (const issue of (outcome.issues || []).slice(0, 200)) {
    const key = dedupeKey(check.id, issue);
    if (seen.has(key)) continue;
    seen.add(key);
    const severity = severityFor(check.tier, issue.severity);
    const alert = alertable(severity);
    const prev = (await db.query('SELECT id, status FROM watchdog_findings WHERE dedupe_key = $1', [key])).rows[0];
    if (!prev) {
      await db.query(
        `INSERT INTO watchdog_findings (dedupe_key, check_id, feature, severity, code, detail, evidence, reproduce, source, status,
                                        first_seen_at, last_seen_at, needs_alert, last_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'open',$10,$10,$11,$12) ON CONFLICT (dedupe_key) DO NOTHING`,
        [key, check.id, clip(check.feature, 200), severity, clip(issue.code, 60), clip(issue.detail, 2000), JSON.stringify(issue.evidence || {}),
         clip(outcome.reproduce, 2000), source, now, alert, runId]);
      stats.opened++; if (alert) stats.alerting++;
    } else if (prev.status === 'resolved') {
      await db.query(
        `UPDATE watchdog_findings SET status = 'open', resolved_at = NULL, reopened_count = reopened_count + 1, occurrences = occurrences + 1,
                severity = $2, detail = $3, evidence = $4::jsonb, reproduce = $5, last_seen_at = $6, needs_alert = $7, alerted_at = NULL, last_run_id = $8
          WHERE id = $1`,
        [prev.id, severity, clip(issue.detail, 2000), JSON.stringify(issue.evidence || {}), clip(outcome.reproduce, 2000), now, alert, runId]);
      stats.reopened++; if (alert) stats.alerting++;
    } else {
      await db.query(
        `UPDATE watchdog_findings SET occurrences = occurrences + 1, severity = $2, detail = $3, evidence = $4::jsonb, reproduce = $5,
                last_seen_at = $6, last_run_id = $7 WHERE id = $1`,
        [prev.id, severity, clip(issue.detail, 2000), JSON.stringify(issue.evidence || {}), clip(outcome.reproduce, 2000), now, runId]);
    }
  }
  // Everything this check reported before but not now has recovered.
  const open = (await db.query(`SELECT id, dedupe_key FROM watchdog_findings WHERE check_id = $1 AND status = 'open'`, [check.id])).rows;
  for (const f of open) {
    if (seen.has(f.dedupe_key)) continue;
    await db.query(`UPDATE watchdog_findings SET status = 'resolved', resolved_at = $2, needs_alert = false WHERE id = $1`, [f.id, now]);
    stats.resolved++;
  }
  return stats;
}

async function openFindings(db, { limit = 200 } = {}) {
  return (await db.query(
    `SELECT id, check_id, feature, severity, code, detail, evidence, reproduce, source, status, first_seen_at, last_seen_at, occurrences, reopened_count, alerted_at
       FROM watchdog_findings WHERE status = 'open'
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, last_seen_at DESC LIMIT $1`, [limit])).rows;
}

async function recentlyResolved(db, { days = 7, limit = 50 } = {}) {
  return (await db.query(
    `SELECT id, check_id, feature, severity, code, detail, first_seen_at, resolved_at, occurrences
       FROM watchdog_findings WHERE status = 'resolved' AND resolved_at > now() - ($1 * interval '1 day') ORDER BY resolved_at DESC LIMIT $2`, [days, limit])).rows;
}

module.exports = { recordCheck, dedupeKey, openFindings, recentlyResolved };
