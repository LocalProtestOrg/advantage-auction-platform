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

const CHECK_INTERVAL_MS = 60_000;          // evaluate the schedule every minute
const STALE_RUN_MINUTES = 30;              // a scheduled run 'running' longer than this is treated as crashed
const AUDIT_ENTITY_ID = '00000000-0000-4000-8000-0000000000e1'; // sentinel entity id for scheduler audit rows
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function logLine(obj) {
  try { console.log('[event-import] ' + JSON.stringify(Object.assign({ t: new Date().toISOString() }, obj))); }
  catch (_) { /* logging must never throw */ }
}

// Configuration (all env-driven; idle unless explicitly enabled).
function cfg(env = process.env) {
  const on = String(env.EVENT_IMPORT_WORKER_ENABLED || '').toLowerCase() === 'true';
  const off = String(env.EVENT_IMPORT_WORKER_DISABLED || '').toLowerCase() === 'true';
  return {
    enabled: on && !off,
    weekday: clampInt(env.EVENT_IMPORT_SCHEDULE_WEEKDAY, 1, 0, 6), // 0=Sun..6=Sat, default Monday
    hour: clampInt(env.EVENT_IMPORT_SCHEDULE_HOUR, 3, 0, 23),      // ET hour, default 03:00 (off-peak)
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

// Due when the ET wall clock is on the configured weekday within the configured hour.
function due(et, schedule) {
  return et.weekday === schedule.weekday && et.hour === schedule.hour;
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
      noAutoPublish: true,          // GOVERNANCE: never auto-publish from the scheduler
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

  logLine({ evt: 'cycle_start', scheduledFor: scheduledFor || null, trigger, apply, sources: sources.length });
  const results = [];
  for (const s of sources) results.push(await runOneSource(s, { trigger, scheduledFor, apply }));

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
// runAllNow: every active source once (manual trigger). apply defaults FALSE (dry run).
async function runAllNow({ apply = false, trigger = 'manual' } = {}) {
  return runScheduledCycle(null, { apply: !!apply, trigger });
}

// ── Scheduler loop ───────────────────────────────────────────────────────────
let ticking = false;        // reentrancy guard (one tick at a time in this process)
let lastCycleDate = null;   // once-per-ET-date guard (this process)

async function tick(nowDate) {
  if (ticking) return;
  ticking = true;
  try {
    const c = cfg();
    if (!c.enabled) return;
    const et = etNow(nowDate);
    if (!due(et, c)) return;
    if (lastCycleDate === et.date) return;   // already handled this date in this process
    lastCycleDate = et.date;                 // claim the date in-process BEFORE running (the DB claim is authoritative across processes)
    await runScheduledCycle(et.date, { apply: true, trigger: 'scheduled' });
  } catch (e) {
    logLine({ evt: 'tick_error', error: String(e && e.message) }); // the scheduler must never crash the worker
  } finally {
    ticking = false;
  }
}

if (require.main === module) {
  const c = cfg();
  console.log(c.enabled
    ? '[event-import] scheduler active - weekly on weekday ' + c.weekday + ' at ' + c.hour + ':00 America/New_York (draft-only; review-queue gated)'
    : '[event-import] scheduler idle - disabled (set EVENT_IMPORT_WORKER_ENABLED=true); worker stays alive, no runs');
  // Always run the interval so the process stays alive and re-evaluates each minute; runs fire only
  // when enabled AND due. Enabling later (which restarts the service) activates the schedule.
  setInterval(() => { tick(); }, CHECK_INTERVAL_MS);
  tick();
}

module.exports = {
  cfg, etNow, due, clampInt, activeSources, reapStaleRun,
  runOneSource, runScheduledCycle, runNow, runAllNow, summarize, tick,
  CHECK_INTERVAL_MS, STALE_RUN_MINUTES, AUDIT_ENTITY_ID,
  // Test-only: reset the in-process scheduler guards between cases.
  _resetForTest: () => { ticking = false; lastCycleDate = null; },
};
