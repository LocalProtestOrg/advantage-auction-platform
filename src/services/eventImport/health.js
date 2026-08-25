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
    at: new Date().toISOString(),
  };
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
  if (snap.last_run && snap.last_run.status === 'failed') {
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

module.exports = { thresholds, inventorySnapshot, evaluateAlerts, ageHours, auctionTargets, auctionInventoryStatus };
