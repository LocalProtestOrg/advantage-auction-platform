'use strict';

/**
 * performanceStatsService — decides whether we may tell a company how it performed, and supplies the
 * truthful first-party numbers when we may.
 *
 * The Owner's rule: never boast about weak statistics. A performance claim is eligible only when the
 * relevant metric has actually reached the threshold (100 by default, platform-configurable).
 * Below that, the answer is 'benefits_only' — describe the programme, quote no numbers.
 *
 * Honesty constraints built into this file:
 *   - Counts come from first-party analytics_events rows and nothing else. No estimates, no modelling,
 *     no provider data, no extrapolation from a sample.
 *   - Nothing is ever rounded UP. Integers are reported exactly as counted.
 *   - Eligibility is evaluated PER METRIC. 247 views with 12 clicks makes the view claim eligible and
 *     the click claim ineligible; the ineligible one is simply not offered.
 *   - The service returns data. It sends nothing, and Phase 1 has no caller that emails.
 */

const db = require('../../db');
const configService = require('../configService');

const DEFAULT_MIN_METRIC = 100;

// The metrics a company may ever be told about, and the analytics event that backs each one. Adding a
// metric here requires a real first-party event type — there is deliberately no computed metric.
const METRICS = Object.freeze({
  event_views:     { event_type: 'event_view',           label: 'event page views' },
  outbound_clicks: { event_type: 'event_outbound_click', label: 'clicks through to your website' },
});

/** The configured threshold, with a safe floor: a misconfigured value can never lower the bar. */
async function threshold() {
  const v = await configService.get(null, 'event_partners.performance_min_metric');
  const n = Number(v);
  return Number.isFinite(n) && n >= DEFAULT_MIN_METRIC ? Math.floor(n) : DEFAULT_MIN_METRIC;
}

/**
 * Raw first-party counts for one organization, attributed via analytics_events.organization_id (set
 * from the event page's host organization). Optional window; unbounded when omitted.
 */
async function rawCounts(organizationId, opts, client) {
  opts = opts || {};
  const c = client || db;
  const params = [organizationId];
  let windowSql = '';
  if (opts.since) { params.push(opts.since); windowSql += ` AND received_at >= $${params.length}`; }
  if (opts.until) { params.push(opts.until); windowSql += ` AND received_at < $${params.length}`; }

  const { rows } = await c.query(
    `SELECT event_type,
            count(*)::int                      AS total,
            count(DISTINCT visitor_id)::int    AS unique_visitors
       FROM analytics_events
      WHERE organization_id = $1
        AND event_type IN ('event_view','event_outbound_click')${windowSql}
      GROUP BY event_type`, params);

  const out = { event_views: 0, event_view_visitors: 0, outbound_clicks: 0, outbound_click_visitors: 0 };
  for (const r of rows) {
    if (r.event_type === 'event_view') { out.event_views = r.total; out.event_view_visitors = r.unique_visitors; }
    if (r.event_type === 'event_outbound_click') { out.outbound_clicks = r.total; out.outbound_click_visitors = r.unique_visitors; }
  }
  return out;
}

/** Same counts scoped to a single event, for a per-event claim ("your September event was viewed N times"). */
async function rawCountsForEvent(eventId, client) {
  const c = client || db;
  const { rows } = await c.query(
    `SELECT event_type, count(*)::int AS total, count(DISTINCT visitor_id)::int AS unique_visitors
       FROM analytics_events
      WHERE event_id = $1 AND event_type IN ('event_view','event_outbound_click')
      GROUP BY event_type`, [eventId]);
  const out = { event_views: 0, event_view_visitors: 0, outbound_clicks: 0, outbound_click_visitors: 0 };
  for (const r of rows) {
    if (r.event_type === 'event_view') { out.event_views = r.total; out.event_view_visitors = r.unique_visitors; }
    if (r.event_type === 'event_outbound_click') { out.outbound_clicks = r.total; out.outbound_click_visitors = r.unique_visitors; }
  }
  return out;
}

/**
 * The deterministic eligibility decision.
 *
 * Returns exactly one of:
 *   { mode: 'performance_stats_eligible', threshold, stats, eligible_metrics[], claims[] }
 *   { mode: 'benefits_only',              threshold, stats, eligible_metrics: [], shortfall }
 *
 * `stats` always carries the true counts (an administrator may see them even when no claim may be
 * made). `claims` contains ONLY the metrics that cleared the threshold, each with the exact integer.
 */
async function evaluate(organizationId, opts, client) {
  opts = opts || {};
  const min = opts.threshold != null ? Math.max(Math.floor(Number(opts.threshold)) || DEFAULT_MIN_METRIC, DEFAULT_MIN_METRIC) : await threshold();
  const stats = opts.eventId
    ? await rawCountsForEvent(opts.eventId, client)
    : await rawCounts(organizationId, opts, client);

  const values = { event_views: stats.event_views, outbound_clicks: stats.outbound_clicks };
  const eligible = Object.keys(METRICS).filter((k) => values[k] >= min);

  if (!eligible.length) {
    const best = Math.max(values.event_views, values.outbound_clicks);
    return {
      mode: 'benefits_only',
      threshold: min,
      stats,
      eligible_metrics: [],
      // How far the strongest metric is from qualifying — for internal planning only, never for copy.
      shortfall: min - best,
      reason: 'no first-party metric has reached the minimum',
    };
  }
  return {
    mode: 'performance_stats_eligible',
    threshold: min,
    stats,
    eligible_metrics: eligible,
    claims: eligible.map((k) => ({
      metric: k,
      label: METRICS[k].label,
      // The exact count. Never rounded, never "over", never "nearly".
      value: values[k],
      event_type: METRICS[k].event_type,
    })),
  };
}

/** Convenience for the future claim-listing follow-up: one company, one decision, no side effects. */
async function evaluateForAuthorization(authorizationId, opts, client) {
  const c = client || db;
  const row = (await c.query(
    'SELECT organization_id, company_name FROM authorized_event_sources WHERE id = $1', [authorizationId])).rows[0];
  if (!row) return null;
  const result = await evaluate(row.organization_id, opts, client);
  return Object.assign({ organization_id: row.organization_id, company_name: row.company_name }, result);
}

module.exports = {
  DEFAULT_MIN_METRIC, METRICS, threshold, rawCounts, rawCountsForEvent,
  evaluate, evaluateForAuthorization,
};
