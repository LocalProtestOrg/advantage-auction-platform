'use strict';

/**
 * directorySyncWorker — automated daily BD -> Advantage.Bid marketplace synchronization.
 *
 * Policy (owner-approved): run the hardened sync once per day at 00:00 America/New_York —
 * fresh every business morning, avoiding evening peak-bidding hours. Reuses the SAME hardened
 * engine (directoryImportService.syncFromBD) that runs manually via `import-bd-directory.js --sync`,
 * so all protections are identical: claimed orgs preserved, verified company->seller links never
 * touched, true-sync of BD-owned public fields, soft-removal reconciliation, freshness stamps,
 * eligibility filters, and idempotent behaviour (repeat runs never duplicate or corrupt).
 *
 * Failure handling: a failed run is logged (console + audit_log), operation continues, and it
 * retries at the NEXT scheduled run (next midnight) — never mid-day, never a partial-corruption
 * state (syncFromBD is idempotent; reconciliation only runs after a full pass).
 *
 * Restart-safe: the once-per-day guard is confirmed against audit_log, so a worker crash/restart
 * during the midnight hour cannot trigger a second run for the same ET day.
 */

require('dotenv').config();
const db = require('../db');
const importer = require('../services/directoryImportService');
const { writeAuditLog } = require('../lib/auditLog');

// Stable sentinel entity id for the (polymorphic) directory-sync audit rows.
const SYNC_ENTITY_ID = '00000000-0000-4000-8000-000000000092';
const CHECK_INTERVAL_MS = 60_000;   // evaluate the schedule every minute

// ── time helpers (DST-aware via Intl, America/New_York) ─────────────────────────
function etDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function etHour(d = new Date()) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(d), 10) % 24;
}
/** Due when we've entered a new ET calendar day and are within the 00:00 ET hour. */
function due(now, lastRunEtDate) {
  return etDate(now) !== lastRunEtDate && etHour(now) === 0;
}

function enabled(env = process.env) {
  if (String(env.MARKETPLACE_SYNC_DISABLED || '').toLowerCase() === 'true') return false;
  if (!env.BD_API_KEY) return false;                                  // needs BD access to sync
  return env.NODE_ENV === 'production' || String(env.MARKETPLACE_SYNC_ENABLED || '').toLowerCase() === 'true';
}

/** Has a scheduled sync already completed/failed for the given ET calendar day? (restart guard) */
async function ranOn(etDay) {
  try {
    // audit_log.created_at is a naive UTC timestamp — treat it as UTC before converting to ET.
    const { rows } = await db.query(
      `SELECT 1 FROM audit_log
         WHERE event_type IN ('marketplace_sync_completed','marketplace_sync_failed')
           AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date = $1::date
         LIMIT 1`, [etDay]);
    return rows.length > 0;
  } catch (_) { return false; }   // on error, do not block the scheduled run
}

/** Execute one sync. Never throws. Logs a concise summary to console + audit_log. */
async function runScheduledSync(trigger = 'scheduled') {
  const started = new Date();
  let summary = null, ok = false, error = null;
  try {
    summary = await importer.syncFromBD({ apply: true, geocode: true });
    ok = true;
  } catch (e) { error = e && e.message ? e.message : String(e); }
  const line = {
    at: started.toISOString(),
    trigger,
    ok,
    processed: summary ? summary.considered : 0,
    created: summary ? summary.created : 0,
    updated: summary ? summary.updated_shell : 0,
    preserved_claimed: summary ? summary.preserved_claimed : 0,
    excluded: summary ? summary.bd_excluded : 0,
    reconciled_removed: summary ? summary.reconciled_removed : 0,
    geocoded: summary ? summary.geocoded : 0,
    geocode_failed: summary ? summary.geocode_failed : 0,
    duration_ms: Date.now() - started.getTime(),
    error,
  };
  console.log('[bd-sync] ' + (ok ? 'OK' : 'FAILED') + ' ' + JSON.stringify(line));
  try {
    await writeAuditLog({
      event_type: ok ? 'marketplace_sync_completed' : 'marketplace_sync_failed',
      entity_type: 'directory_sync', entity_id: SYNC_ENTITY_ID, actor_id: null, metadata: line,
    });
  } catch (_) { /* audit is best-effort; never affects operation */ }
  return line;
}

let lastRunEtDate = null;
async function tick() {
  try {
    const now = new Date();
    if (!due(now, lastRunEtDate)) return;
    const today = etDate(now);
    if (await ranOn(today)) { lastRunEtDate = today; return; }   // already ran today (e.g. after restart)
    lastRunEtDate = today;                                       // claim the day BEFORE running (one run/day)
    await runScheduledSync('scheduled');
  } catch (_) { /* scheduler must never crash the worker */ }
}

if (require.main === module) {
  if (enabled()) {
    console.log('[bd-sync] scheduler started — daily at 00:00 America/New_York');
    setInterval(() => { tick(); }, CHECK_INTERVAL_MS);
    tick();   // evaluate once at boot (only runs if it is the midnight hour of an un-run day)
  } else {
    console.log('[bd-sync] scheduler disabled (set MARKETPLACE_SYNC_ENABLED=true / NODE_ENV=production + BD_API_KEY)');
  }
}

module.exports = { etDate, etHour, due, enabled, ranOn, runScheduledSync, tick };
