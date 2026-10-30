'use strict';

/**
 * runner — runs due server checks, records findings, sends alerts. Also records browser results posted to the ingest.
 *
 *   runServerChecks({ db, baseUrl, ids?, force?, source? })  → run summary
 *   recordExternal({ db, source: 'browser', results })       → run summary (results: [{ check_id, status, issues, reproduce }])
 *   sendAlerts({ db, send })                                  → { sent, findings }
 *   summary(db)                                               → short status for dashboards and reports
 *
 * Switches (environment): WATCHDOG_ENABLED=true runs the scheduled checks (the worker is idle otherwise);
 * WATCHDOG_ALERTS_ENABLED=true emails new or re-opened critical/high findings to info@advantage.bid. With alerts off,
 * findings are still recorded and shown on the dashboard, and their alert flag is cleared so no backlog is mailed later.
 */

const registry = require('./registry');
const store = require('./findingsStore');
const { readOnlyGet } = require('./httpChecks');

const ALERT_TO = 'info@advantage.bid';
const on = (k) => String(process.env[k] || '').toLowerCase() === 'true';
const enabled = () => on('WATCHDOG_ENABLED');
const alertsEnabled = () => on('WATCHDOG_ALERTS_ENABLED');
const baseUrlFromEnv = () => (process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');

async function startRun(db, source) {
  return (await db.query('INSERT INTO watchdog_runs (source) VALUES ($1) RETURNING id', [source])).rows[0].id;
}
async function finishRun(db, runId, t) {
  await db.query(
    `UPDATE watchdog_runs SET finished_at = now(), checks_run = $2, checks_failed = $3, checks_skipped = $4, opened = $5, resolved = $6, summary = $7::jsonb, error = $8 WHERE id = $1`,
    [runId, t.run, t.failed, t.skipped, t.opened + t.reopened, t.resolved, JSON.stringify(t.summary || {}), t.error || null]);
}
const tally = () => ({ run: 0, failed: 0, skipped: 0, opened: 0, reopened: 0, resolved: 0, alerting: 0, summary: {} });
function add(t, checkId, outcome, s) {
  t.run++; if (outcome.status === 'fail') t.failed++; if (outcome.status === 'skipped') t.skipped++;
  t.opened += s.opened; t.reopened += s.reopened; t.resolved += s.resolved; t.alerting += s.alerting;
  t.summary[checkId] = outcome.status;
}

async function runServerChecks({ db, baseUrl = baseUrlFromEnv(), ids = null, force = false, source = 'server', fetchImpl, now = new Date() } = {}) {
  const state = new Map((await db.query('SELECT check_id, last_run_at FROM watchdog_check_state')).rows.map((r) => [r.check_id, r.last_run_at]));
  const due = registry.SERVER_CHECKS.filter((c) => (ids ? ids.includes(c.id) : true) && (force || ids || registry.isDue(c.tier, state.get(c.id), now)));
  if (!due.length) return { ran: 0, due: 0 };
  const runId = await startRun(db, source);
  const t = tally();
  const ctx = { baseUrl, cache: {}, get: (p, o) => readOnlyGet(baseUrl, p, { fetchImpl, ...(o || {}) }) };
  for (const c of due) {
    const started = Date.now();
    let outcome;
    try { outcome = await c.run(ctx); }
    catch (e) { outcome = { status: 'fail', issues: [{ code: 'CHECK_ERROR', severity: 'warning', detail: 'the check itself failed: ' + e.message }], reproduce: 'watchdog check ' + c.id }; }
    outcome.durationMs = Date.now() - started;
    add(t, c.id, outcome, await store.recordCheck(db, { runId, source, check: c, outcome }));
  }
  await finishRun(db, runId, t);
  return { run_id: runId, ran: t.run, failed: t.failed, skipped: t.skipped, opened: t.opened, reopened: t.reopened, resolved: t.resolved, alerting: t.alerting };
}

const MAX_RESULTS = 100; const MAX_ISSUES = 50;
const SEVERITIES = new Set(['critical', 'warning']);
const STATUSES = new Set(['ok', 'fail', 'skipped']);
// Evidence from outside: at most 12 keys of short primitive values (strings clipped), nothing nested.
function cleanEvidence(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  const out = {};
  for (const [k, v] of Object.entries(e).slice(0, 12)) {
    const key = String(k).replace(/[^\w.-]/g, '').slice(0, 40);
    if (!key) continue;
    if (typeof v === 'string') out[key] = v.slice(0, 500);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/** Record results from the browser job. Unknown checks and malformed entries are refused, never stored. */
async function recordExternal({ db, source = 'browser', results }) {
  if (!Array.isArray(results) || !results.length || results.length > MAX_RESULTS) { const e = new Error('results must be a list of 1 to 100 check results'); e.status = 422; throw e; }
  const clean = [];
  for (const r of results) {
    const check = r && registry.BROWSER_CHECKS.find((c) => c.id === r.check_id);
    if (!check || !STATUSES.has(r.status)) { const e = new Error('unknown check or status: ' + String(r && r.check_id).slice(0, 60)); e.status = 422; throw e; }
    const issues = (Array.isArray(r.issues) ? r.issues : []).slice(0, MAX_ISSUES).map((i) => ({
      code: String(i && i.code || 'UNKNOWN').replace(/[^A-Z0-9_]/gi, '').slice(0, 60) || 'UNKNOWN',
      severity: SEVERITIES.has(i && i.severity) ? i.severity : 'warning',
      detail: String(i && i.detail || '').slice(0, 1000),
      evidence: cleanEvidence(i && i.evidence),
    }));
    clean.push({ check, outcome: { status: r.status, issues, reproduce: String(r.reproduce || '').slice(0, 2000), durationMs: Number(r.duration_ms) || null } });
  }
  const runId = await startRun(db, source);
  const t = tally();
  for (const { check, outcome } of clean) add(t, check.id, outcome, await store.recordCheck(db, { runId, source, check, outcome }));
  await finishRun(db, runId, t);
  return { run_id: runId, ran: t.run, failed: t.failed, opened: t.opened, reopened: t.reopened, resolved: t.resolved, alerting: t.alerting };
}

function alertText(findings) {
  const lines = ['Advantage.Bid site watchdog: ' + findings.length + ' new problem' + (findings.length === 1 ? '' : 's') + ' need attention.', ''];
  for (const f of findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.feature}`);
    lines.push('  What: ' + f.detail);
    if (f.reproduce) lines.push('  Reproduce: ' + f.reproduce);
    lines.push('  ' + (f.reopened_count ? `Came back (re-opened ${f.reopened_count} time${f.reopened_count === 1 ? '' : 's'})` : 'First seen ' + new Date(f.first_seen_at).toISOString()));
    lines.push('');
  }
  lines.push('Each problem is reported once. It closes by itself when the check passes again. Dashboard: /admin/site-watchdog.html');
  return lines.join('\n');
}

/** Email new / re-opened critical and high findings once. `send` defaults to the platform email service. */
async function sendAlerts({ db, send = null } = {}) {
  const pending = (await db.query(
    `SELECT id, feature, severity, detail, reproduce, first_seen_at, reopened_count FROM watchdog_findings
      WHERE status = 'open' AND needs_alert = true AND severity IN ('critical','high')
      ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, first_seen_at`)).rows;
  if (!pending.length) return { sent: false, findings: 0 };
  const ids = pending.map((f) => f.id);
  if (!alertsEnabled()) {
    await db.query('UPDATE watchdog_findings SET needs_alert = false WHERE id = ANY($1::uuid[])', [ids]);
    return { sent: false, findings: pending.length, reason: 'alerts_disabled' };
  }
  const mail = send || require('../emailService').sendEmail;
  const critical = pending.filter((f) => f.severity === 'critical').length;
  const subject = `Advantage.Bid site watchdog: ${critical ? critical + ' critical' : pending.length + ' high'} problem${(critical || pending.length) === 1 ? '' : 's'}`;
  const text = alertText(pending);
  const res = await mail({ to: ALERT_TO, subject, text, html: '<pre style="font-family:monospace;white-space:pre-wrap">' + text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</pre>' });
  if (res && res.skipped) return { sent: false, findings: pending.length, reason: 'email_not_configured' };   // keep needs_alert: retried next tick
  await db.query('UPDATE watchdog_findings SET needs_alert = false, alerted_at = now() WHERE id = ANY($1::uuid[])', [ids]);
  return { sent: true, findings: pending.length };
}

/** Short status for dashboards and reports. Safe before migration 210 (returns null). */
async function summary(db) {
  const reg = (await db.query(`SELECT to_regclass('public.watchdog_findings') AS t`)).rows[0];
  if (!reg || !reg.t) return null;
  const counts = (await db.query(`SELECT severity, count(*)::int n FROM watchdog_findings WHERE status = 'open' GROUP BY 1`)).rows;
  const by = Object.fromEntries(counts.map((r) => [r.severity, r.n]));
  const last = (await db.query(`SELECT source, started_at, finished_at, checks_run, checks_failed FROM watchdog_runs ORDER BY started_at DESC LIMIT 1`)).rows[0] || null;
  const lastBrowser = (await db.query(`SELECT started_at FROM watchdog_runs WHERE source = 'browser' ORDER BY started_at DESC LIMIT 1`)).rows[0] || null;
  const open = Object.values(by).reduce((a, b) => a + b, 0);
  return {
    enabled: enabled(), alerts_enabled: alertsEnabled(),
    open, open_by_severity: { critical: by.critical || 0, high: by.high || 0, normal: by.normal || 0, warning: by.warning || 0 },
    overall: (by.critical ? 'CRITICAL' : by.high ? 'DEGRADED' : 'HEALTHY'),
    last_run: last, last_browser_run_at: lastBrowser ? lastBrowser.started_at : null,
  };
}

module.exports = { runServerChecks, recordExternal, sendAlerts, summary, alertText, enabled, alertsEnabled, baseUrlFromEnv, ALERT_TO };
