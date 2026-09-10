'use strict';

/**
 * outcomeAttributionService — campaign → session → user → marketplace action → transaction / seller outcome
 * (Phase 3P.2 marketplace_outcome_attribution + director_facts). Reads ONLY first-party paid-growth sources:
 *   marketing_paid_cost_facts (DELIVERED: spend / impressions / clicks as the provider reported them)
 *   marketing_attribution_touches (sessions that arrived from the campaign)
 *   analytics_events (engagement inside those sessions)
 *   marketing_conversion_events (outcomes with the attribution snapshot taken at write time)
 * Each outcome keeps its class: MEASURED (campaign touch inside the look-back) · INFLUENCED · ATTRIBUTION_UNAVAILABLE.
 * Nothing here reads the Marketing Package ledger — package economics are structurally out of scope.
 */
const db = require('../../db');
const defs = require('../../lib/conversionDefinitions');

const FUNNEL = {
  registrations: ['buyer_registered', 'seller_registered', 'email_signup'],
  intent: ['watch_lot', 'seller_inquiry', 'assisted_service_inquiry', 'auction_draft_created'],
  marketplace_actions: ['bid', 'auction_published'],
  outcomes: ['purchase', 'auction_published'],
};
const CK = `COALESCE(attribution->'last_paid_touch'->>'campaign_key', attribution->'last_touch'->>'campaign_key')`;

async function campaignFacts({ campaignKey = null, from = null, to = null } = {}, runner) {
  const r = runner || db;
  const p = [campaignKey, from, to];
  const cost = (await r.query(
    `SELECT campaign_key, COALESCE(SUM(spend_cents),0)::bigint spend_cents, COALESCE(SUM(impressions),0)::bigint impressions, COALESCE(SUM(clicks),0)::bigint clicks
       FROM marketing_paid_cost_facts WHERE ($1::text IS NULL OR campaign_key=$1) AND ($2::date IS NULL OR fact_date >= $2) AND ($3::date IS NULL OR fact_date <= $3)
      GROUP BY campaign_key`, p)).rows;
  const sessions = (await r.query(
    `SELECT t.campaign_key, count(DISTINCT COALESCE(t.session_id, t.id::text))::int sessions,
            count(DISTINCT t.visitor_id)::int visitors,
            count(DISTINCT COALESCE(t.session_id, t.id::text)) FILTER (WHERE (SELECT count(*) FROM analytics_events e WHERE e.session_id = t.session_id AND t.session_id IS NOT NULL) >= 2)::int engaged_sessions,
            max(t.channel) channel, max(t.utm_source) utm_source
       FROM marketing_attribution_touches t
      WHERE t.campaign_key IS NOT NULL AND ($1::text IS NULL OR t.campaign_key=$1) AND ($2::date IS NULL OR t.touched_at >= $2) AND ($3::date IS NULL OR t.touched_at < ($3::date + 1))
      GROUP BY t.campaign_key`, p)).rows;
  const conv = (await r.query(
    `SELECT ${CK} campaign_key, conversion_key, attribution->>'class' cls, count(*)::int n, COALESCE(SUM(value_cents),0)::bigint value_cents
       FROM marketing_conversion_events
      WHERE ${CK} IS NOT NULL AND ($1::text IS NULL OR ${CK} = $1) AND ($2::date IS NULL OR occurred_at >= $2) AND ($3::date IS NULL OR occurred_at < ($3::date + 1))
      GROUP BY 1,2,3`, p)).rows;
  const map = new Map();
  const get = (k) => { if (!map.has(k)) map.set(k, { campaign_key: k, spend_cents: 0, impressions: 0, clicks: 0, sessions: 0, engaged_sessions: 0, visitors: 0, channel: null, conversions: {}, by_class: {}, value_cents: 0 }); return map.get(k); };
  for (const c of cost) Object.assign(get(c.campaign_key), { spend_cents: Number(c.spend_cents), impressions: Number(c.impressions), clicks: Number(c.clicks) });
  for (const s of sessions) Object.assign(get(s.campaign_key), { sessions: s.sessions, engaged_sessions: s.engaged_sessions, visitors: s.visitors, channel: s.channel });
  for (const x of conv) {
    const f = get(x.campaign_key);
    f.conversions[x.conversion_key] = (f.conversions[x.conversion_key] || 0) + x.n;
    f.by_class[x.cls || 'ATTRIBUTION_UNAVAILABLE'] = (f.by_class[x.cls || 'ATTRIBUTION_UNAVAILABLE'] || 0) + x.n;
    f.value_cents += Number(x.value_cents);
  }
  for (const f of map.values()) {
    f.funnel = {};
    for (const [stage, keys] of Object.entries(FUNNEL)) f.funnel[stage] = keys.reduce((a, k) => a + (f.conversions[k] || 0), 0);
    f.first_party_conversions = Object.entries(f.conversions).filter(([k]) => (defs.get(k) || {}).success_signal).reduce((a, [, n]) => a + n, 0);
  }
  return [...map.values()];
}

/** Cost per first-party outcome for a named success signal (null when no outcomes yet — never a fabricated CPA). */
function costPerOutcome(f, successSignal) {
  const n = successSignal ? (f.conversions[successSignal] || 0) : f.first_party_conversions;
  return n > 0 ? Math.round(f.spend_cents / n) : null;
}

/** Whole-platform first-party totals by class (what the Director can and cannot attribute). */
async function classTotals({ from = null, to = null } = {}, runner) {
  const r = runner || db;
  const q = await r.query(
    `SELECT conversion_key, COALESCE(attribution->>'class','ATTRIBUTION_UNAVAILABLE') cls, count(*)::int n
       FROM marketing_conversion_events WHERE ($1::date IS NULL OR occurred_at >= $1) AND ($2::date IS NULL OR occurred_at < ($2::date + 1))
      GROUP BY 1,2 ORDER BY 1,2`, [from, to]);
  return q.rows;
}

module.exports = { campaignFacts, costPerOutcome, classTotals, FUNNEL };
