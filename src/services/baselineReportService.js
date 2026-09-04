'use strict';

/**
 * baselineReportService — captures the HONEST pre-autonomous-marketing baseline from historical platform
 * facts (no behavioral data required for most metrics) into an immutable snapshot (marketing_baselines).
 * History is never rewritten. Metrics that cannot be measured are recorded as UNKNOWN, never inferred.
 */
const db = require('../db');

// Each metric: { key, window, definition, sql (→ single numeric) , limitations? } OR a text UNKNOWN.
function metricDefs() {
  return [
    // SELLER
    { key: 'seller_profiles_total', window: 'all_time', def: 'seller_profiles rows', sql: `SELECT count(*)::numeric v FROM seller_profiles` },
    { key: 'seller_signups_completed', window: 'all_time', def: 'sellers with a signed/countersigned agreement', sql: `SELECT count(DISTINCT seller_profile_id)::numeric v FROM agreements WHERE status IN ('signed','countersigned')` },
    { key: 'seller_signup_abandoned', window: 'now', def: 'enrolled >24h with no signed agreement, not waived', sql: `SELECT count(*)::numeric v FROM seller_profiles sp WHERE sp.created_at < now() - interval '24 hours' AND sp.agreement_waived_at IS NULL AND NOT EXISTS (SELECT 1 FROM agreements a WHERE a.seller_profile_id=sp.id AND a.status IN ('signed','countersigned'))` },
    // BUYER
    { key: 'users_total', window: 'all_time', def: 'user accounts', sql: `SELECT count(*)::numeric v FROM users` },
    { key: 'registered_non_bidders', window: 'now', def: 'registered users with no bid', sql: `SELECT count(*)::numeric v FROM users u WHERE (u.role='buyer' OR EXISTS(SELECT 1 FROM auction_buyers ab WHERE ab.user_id=u.id)) AND NOT EXISTS(SELECT 1 FROM bids b WHERE b.bidder_user_id=u.id)` },
    { key: 'distinct_bidders', window: 'all_time', def: 'distinct users who placed a bid', sql: `SELECT count(DISTINCT bidder_user_id)::numeric v FROM bids WHERE bidder_user_id IS NOT NULL` },
    { key: 'bids_total', window: 'all_time', def: 'bids placed', sql: `SELECT count(*)::numeric v FROM bids` },
    { key: 'watchlist_adds', window: 'all_time', def: 'watchlist entries', sql: `SELECT count(*)::numeric v FROM watchlists` },
    { key: 'watchers_no_bid', window: 'now', def: 'users watching an open lot with no bid on it', sql: `SELECT count(DISTINCT w.user_id)::numeric v FROM watchlists w JOIN lots l ON l.id=w.lot_id WHERE l.state IN ('open','active') AND NOT EXISTS(SELECT 1 FROM bids b WHERE b.lot_id=w.lot_id AND b.bidder_user_id=w.user_id)` },
    // SUBSCRIBER
    { key: 'subscribers_total', window: 'all_time', def: 'marketing_contacts (non-demo) with a permission', sql: `SELECT count(*)::numeric v FROM marketing_contacts WHERE is_demo=false AND permission_basis IN ('platform_relationship','explicit_opt_in','follower_optin')` },
    // AUCTIONS / EVENTS
    { key: 'active_auctions', window: 'now', def: 'auctions in published/active, not archived, syndicated', sql: `SELECT count(*)::numeric v FROM auctions WHERE state IN ('published','active') AND is_archived IS NOT TRUE AND marketplace_status='syndicated' AND is_demo IS NOT TRUE` },
    { key: 'active_events', window: 'now', def: 'published events not ended', sql: `SELECT count(*)::numeric v FROM events WHERE status='published' AND (end_at IS NULL OR end_at >= now())` },
    { key: 'open_lots', window: 'now', def: 'lots currently open/active', sql: `SELECT count(*)::numeric v FROM lots WHERE state IN ('open','active')` },
    // CRM
    { key: 'crm_actionable_prospects', window: 'now', def: 'actionable, unconverted sales prospects', sql: `SELECT count(*)::numeric v FROM sales_prospects WHERE COALESCE(is_actionable,true)=true` , optional: true },
    // BEHAVIORAL
    { key: 'behavioral_events_total', window: 'all_time', def: 'analytics_events rows', sql: `SELECT count(*)::numeric v FROM analytics_events` },
    { key: 'behavioral_events_with_visitor', window: 'all_time', def: 'analytics_events carrying a first-party visitor_id', sql: `SELECT count(*)::numeric v FROM analytics_events WHERE visitor_id IS NOT NULL` },
    { key: 'identity_links', window: 'all_time', def: 'behavioral_identity_links rows', sql: `SELECT count(*)::numeric v FROM behavioral_identity_links` },
    { key: 'marketing_signals_active', window: 'now', def: 'active derived signals', sql: `SELECT count(*)::numeric v FROM marketing_signals WHERE active=true` },
    { key: 'audience_members_active', window: 'now', def: 'active audience memberships', sql: `SELECT count(*)::numeric v FROM marketing_audience_members WHERE exited_at IS NULL` },
  ];
}

// Capture a snapshot. Returns { snapshot_key, metrics: [...] }.
async function snapshot(runner) {
  const r = runner || db;
  const key = 'baseline_' + new Date().toISOString();
  const metrics = [];
  for (const m of metricDefs()) {
    let value = null; let limitations = null;
    try { value = Number((await r.query(m.sql)).rows[0].v); }
    catch (e) { limitations = 'UNKNOWN — not measurable (' + (e.message || 'error').slice(0, 80) + ')'; }
    await r.query(
      `INSERT INTO marketing_baselines (snapshot_key, metric_key, value_numeric, window_label, definition, limitations)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [key, m.key, value, m.window, m.def, limitations]);
    metrics.push({ metric_key: m.key, value, window: m.window, definition: m.def, limitations });
  }
  return { snapshot_key: key, metrics };
}

// Latest snapshot (grouped).
async function latest(runner) {
  const r = runner || db;
  const k = (await r.query(`SELECT snapshot_key FROM marketing_baselines ORDER BY captured_at DESC LIMIT 1`)).rows[0];
  if (!k) return { snapshot_key: null, metrics: [] };
  const rows = (await r.query(`SELECT metric_key, value_numeric, window_label, definition, limitations, captured_at FROM marketing_baselines WHERE snapshot_key=$1 ORDER BY metric_key`, [k.snapshot_key])).rows;
  return { snapshot_key: k.snapshot_key, metrics: rows };
}

/**
 * Subscriber placement baseline (§12): per signup_placement over the last 90 days, downstream
 * participation. Metrics that cannot be linked deterministically are marked UNKNOWN (never inferred).
 */
async function subscriberPlacement(runner) {
  const r = runner || db;
  const { rows } = await r.query(`
    SELECT s.signup_placement AS placement,
           count(DISTINCT mc.id)::int AS subscribers,
           count(DISTINCT mc.user_id) FILTER (WHERE mc.user_id IS NOT NULL)::int AS registered,
           count(DISTINCT w.user_id)::int AS watched,
           count(DISTINCT b.bidder_user_id)::int AS bid,
           count(DISTINCT l.winning_buyer_user_id)::int AS purchased
      FROM marketing_contact_sources s
      JOIN marketing_contacts mc ON mc.id = s.contact_id AND mc.is_demo = false
      LEFT JOIN watchlists w ON w.user_id = mc.user_id
      LEFT JOIN bids b ON b.bidder_user_id = mc.user_id
      LEFT JOIN lots l ON l.winning_buyer_user_id = mc.user_id AND l.state='closed'
     WHERE s.source_type = 'newsletter_signup' AND s.created_at > now() - interval '90 days'
     GROUP BY s.signup_placement ORDER BY subscribers DESC`);
  return { window: 'last_90d', rows, note: 'Downstream participation by placement; not vanity signup count. Rows with no deterministic linkage would show 0 (not inferred).' };
}

module.exports = { snapshot, latest, subscriberPlacement, metricDefs };
