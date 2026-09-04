'use strict';

/**
 * marketDiagnosisService — classifies each active market (supply/demand/discovery/conversion/balanced/
 * unknown) from platform facts (event_markets geography + auctions/events supply + bidders/subscribers
 * demand proxies). Returns the FACTS supporting each diagnosis. Never forces a classification without
 * sufficient evidence. Feeds the Director opportunity board; does not execute marketing.
 */
const db = require('../db');

// Evidence gathering per market. A market is defined by event_markets (center + radius_km) or the
// 'national' fallback (no coordinates → nationwide).
async function gather(r, market) {
  if (market.slug === 'national' || market.center_lat == null) {
    const supply = (await r.query(`SELECT count(*)::int n FROM events WHERE status='published' AND (end_at IS NULL OR end_at>=now())`)).rows[0].n;
    const auctions = (await r.query(`SELECT count(*)::int n FROM auctions WHERE state IN ('published','active') AND is_archived IS NOT TRUE`)).rows[0].n;
    const subscribers = (await r.query(`SELECT count(*)::int n FROM marketing_contacts WHERE is_demo=false`)).rows[0].n;
    const bidders = (await r.query(`SELECT count(DISTINCT bidder_user_id)::int n FROM bids`)).rows[0].n;
    return { supply_events: supply, supply_auctions: auctions, subscribers, bidders };
  }
  const km = market.radius_km || 120;
  const near = `3958.7613*0.621371 * acos(LEAST(1,GREATEST(-1, sin(radians($1))*sin(radians(LAT)) + cos(radians($1))*cos(radians(LAT))*cos(radians(LNG)-radians($2))))) <= $3`;
  const p = [market.center_lat, market.center_lng, km * 0.621371]; // radius_km→miles
  const supply = (await r.query(`SELECT count(*)::int n FROM events e WHERE e.status='published' AND (e.end_at IS NULL OR e.end_at>=now()) AND e.lat IS NOT NULL AND ${near.replace(/LAT/g,'e.lat').replace(/LNG/g,'e.lng')}`, p)).rows[0].n;
  const auctions = (await r.query(`SELECT count(*)::int n FROM auctions a WHERE a.state IN ('published','active') AND a.is_archived IS NOT TRUE AND a.lat IS NOT NULL AND ${near.replace(/LAT/g,'a.lat').replace(/LNG/g,'a.lng')}`, p)).rows[0].n;
  const subscribers = (await r.query(`SELECT count(*)::int n FROM marketing_contacts mc WHERE mc.is_demo=false AND mc.latitude IS NOT NULL AND ${near.replace(/LAT/g,'mc.latitude').replace(/LNG/g,'mc.longitude')}`, p)).rows[0].n;
  return { supply_events: supply, supply_auctions: auctions, subscribers, bidders: null };
}

// Deterministic classification with explicit thresholds; UNKNOWN when evidence is thin.
function classify(ev) {
  const supply = (ev.supply_events || 0) + (ev.supply_auctions || 0);
  const demand = ev.subscribers || 0;
  if (supply === 0 && demand === 0) return { classification: 'unknown', reason: 'no supply and no demand evidence' };
  if (supply === 0 && demand > 0) return { classification: 'supply_shortage', reason: `${demand} subscribers but 0 active supply` };
  if (supply > 0 && demand === 0) return { classification: 'demand_shortage', reason: `${supply} active supply but 0 local subscribers` };
  if (supply >= 3 && demand < supply) return { classification: 'demand_shortage', reason: `supply ${supply} outpaces demand proxy ${demand}` };
  if (demand >= 3 && supply < 2) return { classification: 'supply_shortage', reason: `demand proxy ${demand} but thin supply ${supply}` };
  return { classification: 'balanced', reason: `supply ${supply}, demand proxy ${demand}` };
}

async function diagnoseAll(runner) {
  const r = runner || db;
  const { rows: markets } = await r.query(`SELECT slug, name, center_lat, center_lng, radius_km, is_active FROM event_markets ORDER BY sort_order`);
  const out = [];
  for (const m of markets) {
    const ev = await gather(r, m);
    const c = classify(ev);
    out.push({ market: m.slug, name: m.name, ...c, evidence: ev });
  }
  return out;
}

module.exports = { diagnoseAll, classify, gather };
