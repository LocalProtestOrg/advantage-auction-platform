'use strict';

/**
 * funnelService — the Claimed Listing funnel, cohort-based by send week (blueprint section 21).
 * Internal (staff, admin, demo, test) and automated (scanner) rows are excluded by default; automated link
 * fetches are reported separately. Opens are NOT measured, by design. The headline figure is activated
 * listings per 100 delivered; visits and claims on their own are vanity measures.
 */

const db = require('../../db');

async function funnel({ includeInternal = false } = {}, runner = db) {
  const filter = includeInternal ? 'true' : 'NOT e.is_internal';
  const rows = (await runner.query(
    `WITH first_send AS (
       SELECT organization_id, date_trunc('week', min(occurred_at)) AS week FROM listing_claim_events WHERE event_key = 'sent' GROUP BY organization_id)
     SELECT to_char(f.week, 'YYYY-MM-DD') AS send_week,
            count(DISTINCT f.organization_id)::int AS companies,
            count(*) FILTER (WHERE e.event_key = 'sent')::int AS sent,
            count(*) FILTER (WHERE e.event_key = 'delivered')::int AS delivered,
            count(*) FILTER (WHERE e.event_key = 'bounced')::int AS bounced,
            count(*) FILTER (WHERE e.event_key = 'complained')::int AS complained,
            count(*) FILTER (WHERE e.event_key = 'unsubscribed')::int AS unsubscribed,
            count(DISTINCT e.organization_id) FILTER (WHERE e.event_key = 'page_view' AND NOT e.is_automated)::int AS visited,
            count(*) FILTER (WHERE e.event_key = 'link_fetch' AND e.is_automated)::int AS automated_link_fetches,
            count(DISTINCT e.organization_id) FILTER (WHERE e.event_key = 'claim_started')::int AS claim_started,
            count(DISTINCT e.organization_id) FILTER (WHERE e.event_key = 'claim_verified')::int AS claimed,
            count(DISTINCT e.organization_id) FILTER (WHERE e.event_key = 'activated')::int AS activated,
            count(DISTINCT e.organization_id) FILTER (WHERE e.event_key = 'pro_interest')::int AS pro_interest,
            count(DISTINCT e.organization_id) FILTER (WHERE e.event_key = 'pro_application')::int AS pro_application,
            count(DISTINCT e.organization_id) FILTER (WHERE e.event_key = 'pro_conversion')::int AS pro_conversion,
            count(*) FILTER (WHERE e.event_key IN ('exit_remove_listing','exit_business_closed','exit_not_my_company','exit_wrong_contact'))::int AS exits,
            count(*) FILTER (WHERE e.event_key = 'reply_received')::int AS replies
       FROM first_send f JOIN listing_claim_events e ON e.organization_id = f.organization_id AND ${filter}
      GROUP BY f.week ORDER BY f.week`)).rows;
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const cohorts = rows.map((r) => Object.assign(r, {
    delivered_rate: rate(r.delivered, r.sent), bounce_rate: rate(r.bounced, r.delivered), complaint_rate: rate(r.complained, r.delivered),
    visit_rate: rate(r.visited, r.delivered), claim_rate_of_delivered: rate(r.claimed, r.delivered), activated_per_100_delivered: rate(r.activated, r.delivered),
    activated_of_claimed: rate(r.activated, r.claimed),
  }));
  const organic = (await runner.query(
    `SELECT count(DISTINCT organization_id) FILTER (WHERE event_key = 'claim_verified')::int AS claimed,
            count(DISTINCT organization_id) FILTER (WHERE event_key = 'self_request')::int AS self_requests,
            count(DISTINCT organization_id) FILTER (WHERE event_key = 'help_request')::int AS help_requests,
            count(DISTINCT organization_id) FILTER (WHERE event_key = 'activated')::int AS activated
       FROM listing_claim_events e WHERE ${filter}`)).rows[0];
  return { cohorts, all_time: organic, opens: 'not measured (no tracking pixel, by design)', excludes: includeInternal ? [] : ['internal', 'automated page views'] };
}

module.exports = { funnel };
