'use strict';

/**
 * inventoryHealthService — the read side of importer health, shared by the worker (hourly health
 * check) and the admin Inventory Health view. Read-only; never throws to its caller.
 *
 *   sourceHealthView(db)      every configured source with its classification, last run and reasons
 *   imageHealth(db)           real / managed / placeholder images across live imported events
 *   rejectionReasons(db, d)   why fetched events were not imported, over the last d days
 *   recentFailures(db)        the latest failed runs with their recorded reason
 *   overview(db, schedule)    all of the above plus the overall HEALTHY / DEGRADED / CRITICAL state
 */

const db0 = require('../../db');
const health = require('./health');
const sourceHealth = require('./sourceHealth');
const { activeEventSql } = require('../../lib/marketplaceVisibility');

async function sourceHealthView(db = db0) {
  const rows = (await db.query(
    `SELECT s.id, s.key, s.name, s.kind, s.status, s.media_policy, s.config, s.health_state, s.health_reason,
            s.consecutive_failures, s.consecutive_zero_runs, s.last_success_at, s.last_nonzero_at, s.last_failure_at,
            s.last_error, s.next_retry_at, s.retry_count, s.health_updated_at,
            r.status AS last_status, r.trigger AS last_trigger, r.started_at AS last_started_at, r.finished_at AS last_finished_at,
            r.fetched, r.eligible, r.created, r.updated, r.skipped_duplicate, r.skipped_quality, r.skipped_ambiguous, r.stats
       FROM import_sources s
       LEFT JOIN LATERAL (SELECT * FROM import_runs x WHERE x.source_id = s.id ORDER BY x.started_at DESC LIMIT 1) r ON true
      ORDER BY s.key`)).rows;
  return rows.map((r) => {
    const stats = r.stats || {};
    const last = { fetched: r.fetched || 0, created: r.created || 0, eligible: r.eligible || 0,
      rejected: (r.skipped_quality || 0) + (r.skipped_ambiguous || 0), zero_reason: stats.zero_reason || null };
    // Active sources carry the state computed at their last run; anything not running is classified
    // from its configuration (a paused / frozen source never runs, so it has no fresher state).
    const cls = r.status === 'active' && r.health_state
      ? { state: r.health_state, reason: r.health_reason }
      : sourceHealth.classify(r, r, last);
    const config = r.config || {};
    return {
      key: r.key, name: r.name, kind: r.kind, connector: config.connector || r.kind, status: r.status, media_policy: r.media_policy,
      // Live = an active, non-static source. A retired or paused source never counts toward health.
      live: r.status === 'active' && r.kind !== 'csv' && cls.state !== 'RETIRED',
      health_state: cls.state, health_reason: cls.reason,
      consecutive_failures: r.consecutive_failures || 0, consecutive_zero_runs: r.consecutive_zero_runs || 0,
      last_success_at: r.last_success_at, last_nonzero_at: r.last_nonzero_at, last_failure_at: r.last_failure_at,
      last_error: r.last_error, next_retry_at: r.next_retry_at,
      last_run: r.last_started_at ? { status: r.last_status, trigger: r.last_trigger, started_at: r.last_started_at, finished_at: r.last_finished_at,
        fetched: r.fetched, eligible: r.eligible, created: r.created, updated: r.updated, duplicates: r.skipped_duplicate,
        rejected: last.rejected, zero_reason: last.zero_reason, access: stats.access || null, reasons: stats.reasons || {} } : null,
    };
  });
}

/**
 * Image health across LIVE imported events. A source whose images are unobtainable by policy (e.g. the
 * federal surplus feed's login-gated photos) declares config.placeholder_images = true; that is a source
 * property, never a hardcoded source name.
 */
async function imageHealth(db = db0) {
  const r = (await db.query(
    `SELECT s.key, s.media_policy, COALESCE((s.config->>'placeholder_images')::boolean, false) AS placeholder_policy,
            count(DISTINCT e.id)::int n,
            count(DISTINCT e.id) FILTER (WHERE EXISTS (SELECT 1 FROM event_images i WHERE i.event_id = e.id))::int with_image,
            count(DISTINCT e.id) FILTER (WHERE EXISTS (SELECT 1 FROM event_images i WHERE i.event_id = e.id AND i.url ILIKE '%res.cloudinary.com%'))::int managed
       FROM events e JOIN event_sources es ON es.event_id = e.id JOIN import_sources s ON s.id = es.source_id
      WHERE ${activeEventSql('e')} GROUP BY s.key, s.media_policy, placeholder_policy`)).rows;
  const bySource = r.map((x) => ({ key: x.key, media_policy: x.media_policy, placeholder_policy: x.placeholder_policy,
    live: x.n, real_image: x.with_image, managed: x.managed, placeholder: x.n - x.with_image }));
  // "Image-capable" = sources whose events can legitimately carry a real image.
  const capable = bySource.filter((x) => !x.placeholder_policy);
  return {
    by_source: bySource,
    eligible: capable.reduce((t, x) => t + x.live, 0),
    real: capable.reduce((t, x) => t + x.real_image, 0),
    managed: bySource.reduce((t, x) => t + x.managed, 0),
    policy_placeholder: bySource.filter((x) => x.placeholder_policy).reduce((t, x) => t + x.placeholder, 0),
  };
}

async function rejectionReasons(db = db0, days = 30) {
  const rows = (await db.query(
    `SELECT s.key, r.stats FROM import_runs r JOIN import_sources s ON s.id = r.source_id
      WHERE r.started_at > now() - make_interval(days => $1)`, [days])).rows;
  const out = {};
  for (const row of rows) {
    const reasons = (row.stats && row.stats.reasons) || {};
    for (const [k, v] of Object.entries(reasons)) {
      if (/^duplicate/.test(k)) continue;           // a re-seen event is not a rejection
      out[row.key] = out[row.key] || {};
      out[row.key][k] = (out[row.key][k] || 0) + Number(v || 0);
    }
  }
  return out;
}

async function recentFailures(db = db0, limit = 15) {
  return (await db.query(
    `SELECT s.key, r.trigger, r.started_at, r.last_error, r.stats->>'zero_reason' AS zero_reason
       FROM import_runs r JOIN import_sources s ON s.id = r.source_id
      WHERE r.status = 'failed' ORDER BY r.started_at DESC LIMIT $1`, [limit])).rows;
}

/** The full picture for the admin view and the hourly health check. */
async function overview(db = db0, { schedule = null, alerts = null } = {}) {
  const snap = await health.inventorySnapshot(db).catch(() => null);
  const sources = await sourceHealthView(db).catch(() => []);
  const images = await imageHealth(db).catch(() => null);
  const evaluated = alerts || (snap ? health.evaluateAlerts(snap, health.thresholds(), { expectedWindow: schedule && schedule.last_expected_window_iso,
    expectedWindowLabel: schedule && schedule.last_expected_window, workerEnabled: schedule ? schedule.enabled : undefined }) : []);
  const overall = health.overallHealth({ snap, alerts: evaluated, images,
    sources: sources.map((s) => ({ key: s.key, live: s.live, health_state: s.health_state })) });
  const review = sources.filter((s) => ['BLOCKED_BY_SOURCE', 'BROKEN', 'NEEDS_REVIEW'].includes(s.health_state))
    .map((s) => ({ source: s.key, state: s.health_state, action: s.health_reason }));
  const zeroWarnings = sources.filter((s) => s.live && s.last_run && !(s.last_run.fetched > 0))
    .map((s) => ({ source: s.key, zero_reason: s.last_run.zero_reason, at: s.last_run.started_at }));
  return { overall, snapshot: snap, alerts: evaluated, sources, images,
    rejection_reasons_30d: await rejectionReasons(db).catch(() => ({})),
    recent_failures: await recentFailures(db).catch(() => []),
    zero_result_warnings: zeroWarnings, needs_review: review, schedule };
}

module.exports = { sourceHealthView, imageHealth, rejectionReasons, recentFailures, overview };
