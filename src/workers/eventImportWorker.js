'use strict';

/**
 * eventImportWorker — the scheduled Event Import Worker (Commit 14, §9 of the plan).
 *
 * Automates the import pipeline while preserving EVERY governance safeguard from Commits 7-13:
 * it reuses the existing engine (services/eventImport/runImport) unchanged, so it inherits the
 * transactional writer, the dedupe ladder, provenance tracking, per-record audit logging, the
 * run ledger, and the per-source weekly cap. It NEVER auto-publishes: every run is forced
 * draft-only (noAutoPublish) so imported events wait in the Admin Review Queue for explicit
 * approval. It never deletes an event and never touches Brilliant Directories.
 *
 * Locking / concurrency: the authoritative lock is the DB partial UNIQUE(source_id, scheduled_for)
 * WHERE trigger='scheduled' index (runLog.startRun). At most ONE scheduled run per source per
 * scheduled_for date can ever exist, across replicas and across restarts — so parallel workers
 * cannot double-run and a crash-restart in the same window cannot duplicate a run or its events.
 * A tick reentrancy flag + a once-per-date in-process guard keep a single process from overlapping.
 *
 * Crash recovery / retry: a scheduled run left 'running' by a crashed process is reaped (marked
 * failed) for operator visibility; the unique claim means it is NOT re-run in the same window, so
 * the retry is the NEXT scheduled window (idempotent, never a partial-corruption state) - the same
 * philosophy as directorySyncWorker. Per-record failures are isolated by the engine; a whole-source
 * connector failure is caught here so the remaining sources still process.
 *
 * Idle by default: does nothing unless EVENT_IMPORT_WORKER_ENABLED=true, so it is inert in dev/CI
 * and stays dormant in production until the owner activates it (after an authorized first source).
 */

require('dotenv').config();
const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const { runImport } = require('../services/eventImport');
const runLog = require('../services/eventImport/runLog');
const { writeAuditLog } = require('../lib/auditLog');
const health = require('../services/eventImport/health');
const marketplaceIntegrity = require('../services/marketplaceIntegrity');
const { sendEmail } = require('../services/emailService');

const CHECK_INTERVAL_MS = 60_000;          // evaluate the schedule every minute
const STALE_RUN_MINUTES = 30;              // a scheduled run 'running' longer than this is treated as crashed
const AUDIT_ENTITY_ID = '00000000-0000-4000-8000-0000000000e1'; // sentinel entity id for scheduler audit rows
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Parse EVENT_IMPORT_SCHEDULE_DAYS="1,4" → sorted unique [1,4] (0=Sun..6=Sat). Empty/invalid → null.
function parseDays(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const days = [...new Set(s.split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
  return days.length ? days : null;
}

function logLine(obj) {
  try { console.log('[event-import] ' + JSON.stringify(Object.assign({ t: new Date().toISOString() }, obj))); }
  catch (_) { /* logging must never throw */ }
}

// Configuration (all env-driven; idle unless explicitly enabled). Runs entirely on Railway (forked by
// server.js) — never depends on a developer workstation being online.
function cfg(env = process.env) {
  const on = String(env.EVENT_IMPORT_WORKER_ENABLED || '').toLowerCase() === 'true';
  const off = String(env.EVENT_IMPORT_WORKER_DISABLED || '').toLowerCase() === 'true';
  // Schedule precedence (highest first):
  //   1. EVENT_IMPORT_SCHEDULE_DAYS="1,4" → multi-day (the PRODUCTION setting: Monday & Thursday).
  //   2. EVENT_IMPORT_SCHEDULE_DAILY=true → every day (estate sales last 1–3 days).
  //   3. EVENT_IMPORT_SCHEDULE_WEEKDAY   → a single weekday (legacy weekly mode).
  // `days` wins when present, so DAILY/WEEKDAY stay for backward compatibility but are overridden.
  const days = parseDays(env.EVENT_IMPORT_SCHEDULE_DAYS);
  const daily = String(env.EVENT_IMPORT_SCHEDULE_DAILY || 'true').toLowerCase() !== 'false';
  // Gated auto-publish: when true, qualifying imports publish through the HARD publicationGate
  // (writer.publishImported); anything failing a rule stays draft with recorded reasons. Off → draft-only.
  const autoPublish = String(env.EVENT_IMPORT_AUTOPUBLISH_ENABLED || '').toLowerCase() === 'true';
  return {
    enabled: on && !off,
    days,                                                         // [1,4] when multi-day; null otherwise
    daily,
    weekday: clampInt(env.EVENT_IMPORT_SCHEDULE_WEEKDAY, 1, 0, 6), // 0=Sun..6=Sat, default Monday (weekly mode)
    hour: clampInt(env.EVENT_IMPORT_SCHEDULE_HOUR, 3, 0, 23),      // ET hour, default 03:00 (off-peak)
    autoPublish,
  };
}

// DST-aware America/New_York wall-clock parts.
function etNow(d = new Date()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d)) p[x.type] = x.value;
  return { date: p.year + '-' + p.month + '-' + p.day, hour: parseInt(p.hour, 10) % 24, weekday: WD[p.weekday] };
}

// The weekday-set the schedule fires on: explicit multi-day list, all 7 (daily), or one weekday.
function scheduleDayset(schedule) {
  if (schedule.days && schedule.days.length) return schedule.days;
  if (schedule.daily) return [0, 1, 2, 3, 4, 5, 6];
  return [schedule.weekday];
}

// Due when the ET wall clock is within the configured hour AND today is a scheduled weekday.
// Multi-day (days) wins over daily wins over single weekday. The once-per-ET-date guard + the DB
// claim keep it to one run per scheduled date, across restarts and replicas.
function due(et, schedule) {
  if (et.hour !== schedule.hour) return false;
  return scheduleDayset(schedule).includes(et.weekday);
}

// Human-readable schedule (for logs, /status, and the owner report). Reflects the active mode.
function scheduleLabel(schedule) {
  const at = ' at ' + String(schedule.hour).padStart(2, '0') + ':00 America/New_York';
  if (schedule.days && schedule.days.length) return schedule.days.map((d) => WD_LONG[d]).join(' & ') + at;
  if (schedule.daily) return 'Daily' + at;
  return 'Weekly on ' + WD_LONG[schedule.weekday] + at;
}

// A structured schedule description for API/reporting payloads.
function describeSchedule(schedule) {
  const set = scheduleDayset(schedule);
  const mode = (schedule.days && schedule.days.length) ? 'multi_day' : (schedule.daily ? 'daily' : 'weekly');
  return {
    mode, days: set, day_labels: set.map((d) => WD_LONG[d]),
    hour: schedule.hour, timezone: 'America/New_York', label: scheduleLabel(schedule),
  };
}

// The next ET date (at the configured hour) the schedule will fire, from `nowDate`. DST-aware:
// it walks forward over ET wall-clock dates, skipping today if this hour has already passed.
function nextScheduledRun(schedule, nowDate = new Date()) {
  const set = scheduleDayset(schedule);
  for (let i = 0; i <= 8; i++) {
    const et = etNow(new Date(nowDate.getTime() + i * 86400000));
    if (!set.includes(et.weekday)) continue;
    if (i === 0 && et.hour >= schedule.hour) continue;   // today's window already passed
    return { et_date: et.date, weekday: et.weekday, hour: schedule.hour,
      label: WD_LONG[et.weekday] + ' ' + et.date + ' at ' + String(schedule.hour).padStart(2, '0') + ':00 ET' };
  }
  return null;
}

// The most recent scheduled window that has ALREADY passed, as a real instant (DST-aware). Used by
// the monitor to decide "we missed a Monday/Thursday window" without a fixed hour threshold that a
// twice-weekly (3–4 day) cadence would otherwise trip between every run.
function lastExpectedWindow(schedule, nowDate = new Date()) {
  const set = scheduleDayset(schedule);
  for (let h = 0; h <= 8 * 24; h++) {
    const cand = new Date(nowDate.getTime() - h * 3.6e6);
    const et = etNow(cand);
    if (set.includes(et.weekday) && et.hour === schedule.hour) {
      return { at: cand, iso: cand.toISOString(), et_date: et.date,
        label: WD_LONG[et.weekday] + ' ' + et.date + ' at ' + String(schedule.hour).padStart(2, '0') + ':00 ET' };
    }
  }
  return null;
}

// The enabled sources the scheduler processes (draft/paused/disabled are excluded).
async function activeSources() {
  const { rows } = await db.query(
    `SELECT id, key, name, kind, weekly_cap, auto_publish, status
       FROM import_sources WHERE status = 'active' ORDER BY name ASC`);
  return rows;
}

// Crash recovery: mark a scheduled run left 'running' by a dead process as failed (visibility only).
// The unique claim still blocks a same-window re-run; retry is the next scheduled window.
async function reapStaleRun(sourceId, scheduledFor) {
  try {
    const { rows } = await db.query(
      `SELECT id FROM import_runs
        WHERE source_id = $1 AND scheduled_for = $2 AND trigger = 'scheduled' AND status = 'running'
          AND started_at < now() - make_interval(mins => $3)`, [sourceId, scheduledFor, STALE_RUN_MINUTES]);
    for (const r of rows) {
      await runLog.finishRun(db, r.id, { status: 'failed', counters: {}, lastError: 'reclaimed: worker restarted mid-run (stale running run)' });
      logLine({ evt: 'stale_run_reaped', runId: r.id, sourceId, scheduledFor });
    }
    return rows.length;
  } catch (e) { logLine({ evt: 'reap_error', sourceId, error: String(e && e.message) }); return 0; }
}

// Run ONE source through the engine. Never throws — a connector/source failure is captured and
// returned so the caller can continue with the remaining sources. Always forces draft-only.
async function runOneSource(source, o) {
  o = o || {};
  const apply = !!o.apply;
  const trigger = o.trigger || 'scheduled';
  if (apply && trigger === 'scheduled') await reapStaleRun(source.id, o.scheduledFor);
  const startedMs = Date.now();
  try {
    const r = await runImport({
      sourceKey: source.key,
      apply,
      trigger,
      scheduledFor: o.scheduledFor || null,
      limit: o.limit,
      // GATED auto-publish: only when the caller opts in (scheduler with EVENT_IMPORT_AUTOPUBLISH_ENABLED).
      // The per-source auto_publish flag AND the hard publicationGate still both apply in the engine, so
      // this only ever publishes events that pass every trust/quality/privacy/date rule; the rest stay draft.
      noAutoPublish: o.autoPublish !== true,
      db,
      withTransaction,
    });
    if (apply && r && r.claimed === false) {
      // Another replica/worker already owns this scheduled run (or a reaped-but-present claim).
      logLine({ evt: 'source_claim_lost', source: source.key, reason: r.reason });
      return { source: source.key, ok: true, claimed: false, reason: r.reason, counters: {} };
    }
    const out = {
      source: source.key, ok: true, applied: apply, dryRun: !apply,
      runId: (r && r.runId) || null, status: (r && r.status) || 'completed',
      capped: !!(r && r.capped), remainingAvailable: r && r.remainingAvailable,
      counters: (r && r.counters) || {}, duration_ms: Date.now() - startedMs,
    };
    logLine({ evt: 'source_done', source: source.key, status: out.status, capped: out.capped, counters: out.counters, dryRun: out.dryRun });
    return out;
  } catch (e) {
    // Whole-source failure (e.g. connector unreachable). The engine already finished the run row as
    // 'failed'; we record it and keep going with the other sources.
    logLine({ evt: 'source_failed', source: source.key, error: String(e && e.message) });
    return { source: source.key, ok: false, error: String(e && e.message), counters: {}, duration_ms: Date.now() - startedMs };
  }
}

// Aggregate per-source results into a single run summary with the required counts.
function summarize(scheduledFor, startedMs, results, extra) {
  const agg = { imported: 0, updated: 0, skipped: 0, duplicates: 0, errors: 0 };
  for (const r of results) {
    const c = r.counters || {};
    agg.imported += c.created || 0;
    agg.updated += c.updated || 0;
    agg.skipped += (c.skipped_quality || 0) + (c.skipped_ambiguous || 0);
    agg.duplicates += c.skipped_duplicate || 0;
    agg.errors += c.failed || 0;
    if (r.ok === false) agg.errors += 1;               // a whole-source failure counts as an error
  }
  return Object.assign({
    scheduledFor: scheduledFor || null,
    started_at: new Date(startedMs).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs,
    sources_total: results.length,
    sources_ok: results.filter((r) => r.ok !== false).length,
    sources_failed: results.filter((r) => r.ok === false).length,
    counts: agg,
    sources: results.map((r) => ({ source: r.source, ok: r.ok !== false, status: r.status || null, runId: r.runId || null, capped: !!r.capped, counters: r.counters || {}, error: r.error || null })),
  }, extra || {});
}

// Run the full scheduled cycle: every active source, apply=true, draft-only. One source failing
// does not stop the others. Writes a best-effort scheduler-level audit row at the end.
async function runScheduledCycle(scheduledFor, opts) {
  opts = opts || {};
  const apply = opts.apply !== false;           // scheduled cycles apply; callers may dry-run
  const trigger = opts.trigger || 'scheduled';
  const startedMs = Date.now();
  let sources = [];
  try { sources = await activeSources(); }
  catch (e) { logLine({ evt: 'cycle_error', error: String(e && e.message) }); return summarize(scheduledFor, startedMs, [], { error: String(e && e.message) }); }

  logLine({ evt: 'cycle_start', scheduledFor: scheduledFor || null, trigger, apply, autoPublish: !!opts.autoPublish, sources: sources.length });
  const results = [];
  for (const s of sources) results.push(await runOneSource(s, { trigger, scheduledFor, apply, autoPublish: !!opts.autoPublish }));

  const summary = summarize(scheduledFor, startedMs, results, { trigger, apply });
  logLine(Object.assign({ evt: 'cycle_end' }, summary.counts, { sources_total: summary.sources_total, sources_failed: summary.sources_failed, duration_ms: summary.duration_ms }));
  if (apply) {
    try {
      await writeAuditLog({
        event_type: summary.sources_failed > 0 ? 'event_import_cycle_partial' : 'event_import_cycle_completed',
        entity_type: 'event_import_scheduler', entity_id: AUDIT_ENTITY_ID, actor_id: null, metadata: summary,
      });
    } catch (_) { /* audit is best-effort; never affects operation */ }
  }
  return summary;
}

// ── Manual / dry-run support (service level; UI is Commit 15) ────────────────
// runNow: one source. apply defaults FALSE (dry run writes nothing). trigger defaults 'manual'.
async function runNow({ sourceKey, apply = false, trigger = 'manual', limit } = {}) {
  const source = (await db.query('SELECT id, key, name, kind, weekly_cap, auto_publish, status FROM import_sources WHERE key = $1', [sourceKey])).rows[0];
  if (!source) throw new Error('Unknown import source: ' + sourceKey);
  return runOneSource(source, { trigger, scheduledFor: null, apply: !!apply, limit });
}
// runAllNow: every active source once (manual trigger). apply defaults FALSE (dry run). autoPublish
// threads into the SAME gated path the scheduler uses (writer.publishImported + publicationGate stay
// authoritative per event) so an owner verification run exercises exactly what a scheduled run does.
async function runAllNow({ apply = false, trigger = 'manual', autoPublish = false } = {}) {
  return runScheduledCycle(null, { apply: !!apply, trigger, autoPublish: !!autoPublish });
}

// ── Health monitoring (runs even when imports are disabled/not-due) ───────────
let lastHealthKey = null;          // once-per-ET-hour routine health guard
let lastCriticalAlertDate = null;  // once-per-ET-date critical-email guard (no spam)
let priorSnapshot = null;          // prior snapshot for sharp-drop detection

// Compute + persist the inventory/health snapshot, log it, and email CRITICAL alerts (once/day).
// Never throws — monitoring must not crash the worker.
async function runHealthCheck(nowDate, o) {
  o = o || {};
  try {
    const et = etNow(nowDate);
    const hourKey = et.date + 'T' + et.hour;
    if (!o.afterCycle && lastHealthKey === hourKey) return null; // routine: at most once per hour
    lastHealthKey = hourKey;
    const c = o.cfg || cfg();
    const now = nowDate || new Date();
    const snap = await health.inventorySnapshot(db);
    // Schedule-aware "missed window" replaces a fixed stale-hours alert: a twice-weekly cadence is
    // 3–4 days apart, so a fixed 36h threshold would fire between every run. We alert only when a
    // scheduled window has passed (+grace) with no successful run since it.
    const lw = c.enabled ? lastExpectedWindow(c, now) : null;
    const next = nextScheduledRun(c, now);
    const alerts = health.evaluateAlerts(snap, health.thresholds(), {
      prior: priorSnapshot, now: now.getTime(),
      expectedWindow: lw ? lw.iso : null, expectedWindowLabel: lw ? lw.label : null,
      workerEnabled: c.enabled,
    });
    priorSnapshot = snap;
    const scheduleInfo = { enabled: c.enabled, schedule: describeSchedule(c), next_scheduled_run: next, last_expected_window: lw ? lw.label : null };
    logLine({ evt: 'health', afterCycle: !!o.afterCycle, snapshot: snap, alerts, schedule: scheduleInfo });
    try {
      await writeAuditLog({
        event_type: alerts.some((a) => a.level === 'critical') ? 'event_inventory_alert' : 'event_inventory_health',
        entity_type: 'event_import_scheduler', entity_id: AUDIT_ENTITY_ID, actor_id: null,
        metadata: Object.assign({ snapshot: snap, alerts, schedule: scheduleInfo }, o.summary ? { run_counts: o.summary.counts, sources: o.summary.sources } : {}),
      });
    } catch (_) { /* audit best-effort */ }
    // Critical-alert EMAIL is opt-in (EVENT_INVENTORY_ALERTS_ENABLED=true) so it never surprises in dev
    // or before the owner is ready; the snapshot + audit row above are always recorded regardless.
    const emailOn = String(process.env.EVENT_INVENTORY_ALERTS_ENABLED || '').toLowerCase() === 'true';
    const criticals = alerts.filter((a) => a.level === 'critical');
    if (emailOn && criticals.length && lastCriticalAlertDate !== et.date) {
      lastCriticalAlertDate = et.date;
      try {
        await sendEmail({
          to: 'info@advantage.bid',
          subject: `Advantage.Bid — event inventory alert (${criticals.length})`,
          text: 'Event inventory health alerts:\n' + criticals.map((a) => `- [${a.code}] ${a.message}`).join('\n')
            + `\n\nActive auctions: ${snap.active_auctions}. Active estate sales: ${snap.active_estate_sales}. `
            + `Total active public: ${snap.total_active_public}. Last successful import: ${snap.last_success_run || 'never'}.`,
        });
      } catch (e) { logLine({ evt: 'alert_email_failed', error: String(e && e.message) }); }
    }
    // ── Continuous Marketplace Integrity monitoring (Phase 6A) ──────────────────
    // Every scheduled run (and each routine hourly check) verifies the canonical DB tally against the
    // live public APIs + SEO surfaces, logging/auditing any anomaly. Opt-in (EVENT_INTEGRITY_MONITOR_
    // ENABLED=true) + needs PUBLIC_BASE_URL; never throws into the worker path.
    try {
      const monitorOn = String(process.env.EVENT_INTEGRITY_MONITOR_ENABLED || '').toLowerCase() === 'true';
      const base = process.env.PUBLIC_BASE_URL || (process.env.FRONTEND_URL || '').split(',')[0];
      if (monitorOn && base) {
        const result = await marketplaceIntegrity.verify({ db, baseUrl: base, live: true });
        const anomalies = result.checks.filter((chk) => chk.status !== 'PASS');
        logLine({ evt: 'marketplace_integrity', overall: result.overall, anomalies: anomalies.map((a) => ({ surface: a.surface, status: a.status, detail: a.detail })) });
        if (result.overall !== 'PASS') {
          try {
            await writeAuditLog({
              event_type: result.overall === 'FAIL' ? 'marketplace_integrity_fail' : 'marketplace_integrity_warning',
              entity_type: 'event_import_scheduler', entity_id: AUDIT_ENTITY_ID, actor_id: null,
              metadata: { overall: result.overall, canonical: result.canonical, anomalies },
            });
          } catch (_) { /* audit best-effort */ }
        }
      }
    } catch (e) { logLine({ evt: 'integrity_monitor_error', error: String(e && e.message) }); }
    return { snapshot: snap, alerts };
  } catch (e) { logLine({ evt: 'health_error', error: String(e && e.message) }); return null; }
}

// ── Scheduler loop ───────────────────────────────────────────────────────────
let ticking = false;        // reentrancy guard (one tick at a time in this process)
let lastCycleDate = null;   // once-per-ET-date guard (this process)

async function tick(nowDate) {
  if (ticking) return;
  ticking = true;
  try {
    const c = cfg();
    // Monitoring runs regardless of enabled/due — a stalled or disabled worker must still surface alerts.
    await runHealthCheck(nowDate);
    if (!c.enabled) return;
    const et = etNow(nowDate);
    if (!due(et, c)) return;
    if (lastCycleDate === et.date) return;   // already handled this date in this process
    lastCycleDate = et.date;                 // claim the date in-process BEFORE running (the DB claim is authoritative across processes)
    const summary = await runScheduledCycle(et.date, { apply: true, trigger: 'scheduled', autoPublish: c.autoPublish });
    await runHealthCheck(nowDate, { afterCycle: true, summary });
  } catch (e) {
    logLine({ evt: 'tick_error', error: String(e && e.message) }); // the scheduler must never crash the worker
  } finally {
    ticking = false;
  }
}

if (require.main === module) {
  const c = cfg();
  const nxt = nextScheduledRun(c);
  console.log(c.enabled
    ? '[event-import] scheduler active - ' + scheduleLabel(c) + (c.autoPublish ? ' (gated auto-publish)' : ' (draft-only; review-queue gated)')
      + '; next: ' + (nxt ? nxt.label : 'n/a')
    : '[event-import] scheduler idle - disabled (set EVENT_IMPORT_WORKER_ENABLED=true); worker stays alive, no runs');
  // Always run the interval so the process stays alive and re-evaluates each minute; runs fire only
  // when enabled AND due. Enabling later (which restarts the service) activates the schedule.
  setInterval(() => { tick(); }, CHECK_INTERVAL_MS);
  tick();
}

module.exports = {
  cfg, etNow, due, clampInt, parseDays, activeSources, reapStaleRun,
  scheduleDayset, scheduleLabel, describeSchedule, nextScheduledRun, lastExpectedWindow,
  runOneSource, runScheduledCycle, runNow, runAllNow, summarize, tick, runHealthCheck,
  CHECK_INTERVAL_MS, STALE_RUN_MINUTES, AUDIT_ENTITY_ID,
  // Test-only: reset the in-process scheduler + health guards between cases.
  _resetForTest: () => { ticking = false; lastCycleDate = null; lastHealthKey = null; lastCriticalAlertDate = null; priorSnapshot = null; },
};
