'use strict';

/**
 * health — event-inventory health snapshot + alert evaluation for the scheduled import worker.
 * Railway-native: computes counts from the DB, evaluates conservative env-configurable thresholds,
 * and returns alerts the worker logs/audits/emails. Never throws to the caller's critical path.
 *
 * Thresholds are DERIVED FROM ACTUAL RECOVERED INVENTORY (currently low) and env-overridable — no
 * arbitrary national target is baked in. Reported values live in the deploy notes.
 */

const db0 = require('../../db');
const { activeEventSql, activeNativeAuctionSql } = require('../../lib/marketplaceVisibility');

// Owner-approved health target for ACTIVE/UPCOMING EXTERNAL auction events. A target, not a mandate to
// fabricate: report the real number. Env-overridable.
function auctionTargets(env = process.env) {
  const n = (k, d) => { const v = parseInt(env[k], 10); return Number.isFinite(v) ? v : d; };
  return { target: n('EXTERNAL_AUCTION_TARGET', 100), low: n('EXTERNAL_AUCTION_LOW', 50) };
}

// HEALTHY >= target · LOW between low..target-1 · CRITICAL < low.
function auctionInventoryStatus(externalActiveAuctions, t = auctionTargets()) {
  const n = Number(externalActiveAuctions) || 0;
  const status = n >= t.target ? 'HEALTHY' : (n >= t.low ? 'LOW' : 'CRITICAL');
  return { external_active_auctions: n, target: t.target, low_threshold: t.low, status };
}

function thresholds(env = process.env) {
  const n = (k, d) => { const v = parseInt(env[k], 10); return Number.isFinite(v) ? v : d; };
  return {
    minActiveAuctions:    n('EVENT_MIN_ACTIVE_AUCTIONS', 1),      // conservative: current active auctions ≈ 2
    minActiveEstateSales: n('EVENT_MIN_ACTIVE_ESTATE_SALES', 1),  // conservative: current active estate sales ≈ 2
    minTotalActive:       n('EVENT_MIN_TOTAL_ACTIVE', 3),         // conservative: current total active ≈ 4
    staleRunHours:        n('EVENT_IMPORT_STALE_HOURS', 36),      // fixed-window fallback (daily/legacy modes)
    missedWindowGraceHours: n('EVENT_IMPORT_MISSED_WINDOW_GRACE_HOURS', 6), // grace after a scheduled window before "missed"
    dropPct:              n('EVENT_INVENTORY_DROP_PCT', 60),      // sharp drop vs prior snapshot
    zeroEligibleRuns:     n('EVENT_IMPORT_ZERO_ELIGIBLE_RUNS', 3),// N consecutive runs with 0 new eligible
  };
}

// Snapshot of public inventory + import-run health. Read-only.
async function inventorySnapshot(db = db0) {
  // Canonical visibility predicate (single definition — src/lib/marketplaceVisibility.js).
  const active = (await db.query(
    `SELECT e.sale_type, count(*)::int n FROM events e
      WHERE ${activeEventSql('e')} GROUP BY e.sale_type`)).rows;
  const byType = active.reduce((m, r) => { m[r.sale_type || 'other'] = r.n; return m; }, {});
  const totalActive = active.reduce((s, r) => s + r.n, 0);
  // Native Advantage.Bid auctions (separate from external/syndicated), via the SAME canonical predicate
  // the public feed uses (excludes demo/archived/non-syndicated). Kept distinct so a big estate-sale
  // count can never mask a drained AUCTION inventory.
  const nativeAuctions = Number((await db.query(
    `SELECT count(*)::int n FROM auctions a WHERE ${activeNativeAuctionSql('a')}`)).rows[0].n) || 0;
  const externalAuctions = byType.auction || 0;
  const auctionStatus = auctionInventoryStatus(externalAuctions);
  const lastSuccess = (await db.query("SELECT max(finished_at) t FROM import_runs WHERE status = 'completed'")).rows[0].t;
  const lastAttempt = (await db.query('SELECT max(started_at) t FROM import_runs')).rows[0].t;
  const lastRun = (await db.query(
    `SELECT trigger, status, started_at, finished_at, fetched, eligible, created, updated,
            skipped_duplicate, skipped_quality, skipped_ambiguous, failed
       FROM import_runs ORDER BY started_at DESC LIMIT 1`)).rows[0] || null;
  // The latest run of every ACTIVE source — so "the importer failed" means every source failed, not
  // merely whichever source happened to run last.
  const latestBySource = await optionalRows(() => db.query(
    `SELECT DISTINCT ON (s.id) s.key, r.status, r.started_at, r.fetched, r.created, r.last_error
       FROM import_sources s JOIN import_runs r ON r.source_id = s.id
      WHERE s.status = 'active'
      ORDER BY s.id, r.started_at DESC`));
  // Live public inventory attributed to each import source (for concentration + the admin view).
  const upcomingBySource = await optionalRows(() => db.query(
    `SELECT s.key, e.sale_type, count(DISTINCT e.id)::int n
       FROM events e JOIN event_sources es ON es.event_id = e.id JOIN import_sources s ON s.id = es.source_id
      WHERE ${activeEventSql('e')} GROUP BY s.key, e.sale_type`));
  return {
    active_auctions: byType.auction || 0,                 // external/syndicated auction EVENTS (public)
    external_auctions: externalAuctions,                  // alias (explicit)
    native_auctions: nativeAuctions,                      // native Advantage.Bid auctions (public)
    total_public_auctions: externalAuctions + nativeAuctions,
    auction_inventory: auctionStatus,                     // { target, low_threshold, status: HEALTHY|LOW|CRITICAL }
    active_estate_sales: byType.estate_sale || 0,
    active_other: byType.other || 0,
    total_active_public: totalActive,
    last_success_run: lastSuccess || null,
    last_attempt_run: lastAttempt || null,
    last_run: lastRun,
    latest_by_source: latestBySource,
    upcoming_by_source: Object.values(upcomingBySource.reduce((m, r) => {
      m[r.key] = m[r.key] || { key: r.key, n: 0, by_type: {} };
      m[r.key].n += r.n; m[r.key].by_type[r.sale_type || 'other'] = r.n; return m;
    }, {})),
    at: new Date().toISOString(),
  };
}

/**
 * Overall inventory health — HEALTHY / DEGRADED / CRITICAL / UNKNOWN. Pure.
 *
 * Two questions are kept apart, because they need different responses:
 *   PIPELINE  is ingestion working?  (scheduler ran its window, live sources succeed)
 *   SUPPLY    is there enough current inventory?  (external auctions vs target, estate sales, spread)
 * A working pipeline with a thin market is a SUPPLY LULL (DEGRADED, nothing to fix in code); a broken
 * pipeline is an INGESTION FAILURE (CRITICAL). The ~100 external-auction figure stays the operating
 * target, not the definition of health.
 *
 *   input: { snap, alerts, sources: [{ key, live, health_state }], images: { eligible, real } }
 */
function overallHealth({ snap, alerts = [], sources = [], images = null, criticalFloor = 3 } = {}) {
  if (!snap) return { state: 'UNKNOWN', pipeline: 'UNKNOWN', supply: 'UNKNOWN', reasons: ['inventory snapshot unavailable'] };
  const reasons = [];
  const live = sources.filter((s) => s.live);
  const working = live.filter((s) => s.health_state === 'HEALTHY' || s.health_state === 'DEGRADED');
  const codes = new Set(alerts.map((a) => a.code));

  let pipeline = 'OK';
  if (codes.has('missed_window')) { pipeline = 'FAILED'; reasons.push('the scheduled import window was missed'); }
  if (live.length && !working.length) { pipeline = 'FAILED'; reasons.push('no live source is working'); }
  if (!snap.last_success_run) { pipeline = 'FAILED'; reasons.push('no successful import on record'); }
  const impaired = live.filter((s) => s.health_state !== 'HEALTHY');
  if (pipeline === 'OK' && impaired.length) { pipeline = 'IMPAIRED'; reasons.push(impaired.length + ' source(s) not healthy: ' + impaired.map((s) => s.key + ' ' + s.health_state).join(', ')); }

  const ai = snap.auction_inventory || { external_active_auctions: snap.external_auctions || 0, target: 100 };
  let supply = 'AT_TARGET';
  if ((snap.total_active_public || 0) < criticalFloor) { supply = 'CRITICAL_LOW'; reasons.push('only ' + (snap.total_active_public || 0) + ' public events are live'); }
  else if (ai.external_active_auctions < ai.target) { supply = 'LULL'; reasons.push(ai.external_active_auctions + ' upcoming external auctions (operating target ' + ai.target + ')'); }
  if (!snap.active_estate_sales) reasons.push('no upcoming estate sales from any compliant source');

  // Concentration: one source carrying most of the inventory is fragile.
  const bySource = snap.upcoming_by_source || [];
  const total = bySource.reduce((t, r) => t + r.n, 0);
  const top = bySource.slice().sort((a, b) => b.n - a.n)[0];
  const concentration = total ? top.n / total : null;
  if (concentration != null && concentration > 0.7 && total >= 5) reasons.push(top.key + ' supplies ' + Math.round(concentration * 100) + '% of upcoming imported inventory');
  if (images && images.eligible > 0 && images.real / images.eligible < 0.5) reasons.push('fewer than half of image-capable events have a real image');

  let state = 'HEALTHY';
  if (pipeline === 'FAILED' || supply === 'CRITICAL_LOW') state = 'CRITICAL';
  else if (pipeline === 'IMPAIRED' || supply === 'LULL' || reasons.length) state = 'DEGRADED';
  const diagnosis = state === 'CRITICAL'
    ? (pipeline === 'FAILED' ? 'INGESTION_FAILURE' : 'INVENTORY_COLLAPSE')
    : pipeline === 'OK' && supply === 'LULL' ? 'SUPPLY_LULL' : pipeline === 'IMPAIRED' ? 'SOURCE_PROBLEM' : 'NONE';
  return { state, diagnosis, pipeline, supply, concentration, reasons };
}

// Supplementary queries must never break the core snapshot (older schemas, partial test doubles).
async function optionalRows(fn) {
  try { const r = await fn(); return (r && Array.isArray(r.rows)) ? r.rows : []; } catch (_) { return []; }
}

function ageHours(iso, now = Date.now()) {
  if (!iso) return Infinity;
  return (now - new Date(iso).getTime()) / 3.6e6;
}

// Pure alert evaluation over a snapshot (+ optional prior snapshot for drop detection).
function evaluateAlerts(snap, t = thresholds(), opts = {}) {
  const now = opts.now || Date.now();
  const alerts = [];
  // Freshness: schedule-aware when a scheduled window is supplied (correct for twice-weekly, whose
  // 3–4 day gaps would trip a fixed hours threshold); otherwise fall back to the fixed staleRunHours.
  if (opts.expectedWindow) {
    const windowMs = new Date(opts.expectedWindow).getTime();
    const cutoff = windowMs + (t.missedWindowGraceHours || 6) * 3.6e6;
    const lastOk = snap.last_success_run ? new Date(snap.last_success_run).getTime() : 0;
    if (now >= cutoff && lastOk < windowMs) {
      alerts.push({ level: 'critical', code: 'missed_window', message: `No successful import since the scheduled ${opts.expectedWindowLabel || opts.expectedWindow} window (last: ${snap.last_success_run || 'never'})` });
    }
  } else if (ageHours(snap.last_success_run, now) > t.staleRunHours) {
    alerts.push({ level: 'critical', code: 'stale_import', message: `No successful event import in ${t.staleRunHours}h (last: ${snap.last_success_run || 'never'})` });
  }
  // The worker is off while the schedule says it should be running — surfaced, not emailed (warn).
  if (opts.workerEnabled === false) {
    alerts.push({ level: 'warn', code: 'worker_disabled', message: 'Event import worker is disabled (EVENT_IMPORT_WORKER_ENABLED is not true)' });
  }
  // Per-source latest runs (when the snapshot carries them): ingestion is FAILED only when every live
  // source's latest run failed. One blocked or broken source among working ones is a source problem,
  // surfaced as a warning and classified per source — not a daily "importer failing" alarm.
  if (Array.isArray(snap.latest_by_source) && snap.latest_by_source.length) {
    const failed = snap.latest_by_source.filter((r) => r.status === 'failed');
    if (failed.length === snap.latest_by_source.length) {
      alerts.push({ level: 'critical', code: 'run_failed', message: `Every active source's latest run FAILED (${failed.map((r) => r.key).join(', ')})` });
    } else if (failed.length) {
      alerts.push({ level: 'warn', code: 'sources_failing', message: `Latest run failed for ${failed.map((r) => r.key + (r.last_error ? ' (' + String(r.last_error).slice(0, 80) + ')' : '')).join('; ')}` });
    }
  } else if (snap.last_run && snap.last_run.status === 'failed') {
    alerts.push({ level: 'critical', code: 'run_failed', message: `Last event-import run FAILED at ${snap.last_run.started_at}` });
  }
  if (snap.total_active_public < t.minTotalActive) {
    alerts.push({ level: 'critical', code: 'low_total_inventory', message: `Active public events ${snap.total_active_public} < threshold ${t.minTotalActive}` });
  }
  if (snap.active_auctions < t.minActiveAuctions) {
    alerts.push({ level: 'warn', code: 'low_auctions', message: `Active auctions ${snap.active_auctions} < threshold ${t.minActiveAuctions}` });
  }
  // Auction-inventory target (owner-approved 100+). CRITICAL (<50) escalates; LOW (50-99) warns. This is
  // the non-silent signal that catches a slow drain toward the "1 auction" failure the owner reported.
  if (snap.auction_inventory && snap.auction_inventory.status !== 'HEALTHY') {
    const ai = snap.auction_inventory;
    alerts.push({
      level: ai.status === 'CRITICAL' ? 'critical' : 'warn',
      code: ai.status === 'CRITICAL' ? 'auctions_critical' : 'auctions_below_target',
      message: `External auction inventory ${ai.external_active_auctions} is ${ai.status} (target ${ai.target}, low<${ai.low_threshold})`,
    });
  }
  if (snap.active_estate_sales < t.minActiveEstateSales) {
    alerts.push({ level: 'warn', code: 'low_estate_sales', message: `Active estate sales ${snap.active_estate_sales} < threshold ${t.minActiveEstateSales}` });
  }
  if (opts.prior && opts.prior.total_active_public > 0) {
    const dropPct = Math.round((1 - snap.total_active_public / opts.prior.total_active_public) * 100);
    if (dropPct >= t.dropPct) alerts.push({ level: 'warn', code: 'sharp_drop', message: `Active inventory dropped ${dropPct}% since the prior check (${opts.prior.total_active_public} → ${snap.total_active_public})` });
  }
  return alerts;
}

module.exports = { thresholds, inventorySnapshot, evaluateAlerts, ageHours, auctionTargets, auctionInventoryStatus, overallHealth };
