'use strict';

/**
 * Claimed Listing prospect scoring (handoff section 3). Deterministic and explainable: every point is a
 * named factor stored with the score. Weights are configuration (claimed_listings.score_weights) so the
 * Director can tune them from pilot evidence without a deploy. MISSING DATA SCORES ZERO — nothing is
 * guessed (Google operating status and reviews are not stored today, so those factors score 0 and are
 * reported as "unknown" until a lookup inside the existing Places budget fills them).
 *
 * Tier A >= 60 · B 40-59 · C < 40.
 */

const dns = require('dns').promises;
const db = require('../../db');
const listingContext = require('./listingContext');
const identity = require('../acquisition/companyIdentityService');
const { V2: TRISTATE_ANCHORS, miles } = require('../paidGrowth/tristateFootprint');
const { normalizeEmail } = require('../../lib/emailNormalize');
const seg = require('../eventPartners/relationshipSegmentationService');

const DEFAULT_WEIGHTS = Object.freeze({ strategic_market: 25, estate_sale_company: 15, auction_house: 10, liquidator: 10, appraiser: 5,
  operating: 15, reputation: 10, no_website: 10, basic_website: 8, no_online_auctions: 8, corporate_email: 5, large_firm_named_employee: -10 });

const HOUSTON = [29.7604, -95.3698];
const HOUSTON_RADIUS_MILES = 60;
const HOUSTON_CITIES = new Set(['houston', 'katy', 'sugar land', 'the woodlands', 'spring', 'pearland', 'pasadena', 'baytown', 'conroe',
  'cypress', 'humble', 'kingwood', 'league city', 'friendswood', 'missouri city', 'tomball', 'richmond', 'rosenberg', 'bellaire',
  'west university place', 'galveston', 'magnolia', 'seabrook', 'webster', 'stafford', 'clear lake', 'montgomery', 'fulshear']);

/** 'houston' | 'ny_tristate' | null. Coordinates first; a Houston-metro city name when coordinates are missing. */
function strategicMarket(row) {
  const lat = row.lat != null ? Number(row.lat) : null;
  const lng = row.lng != null ? Number(row.lng) : null;
  if (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)) {
    if (miles([lat, lng], HOUSTON) <= HOUSTON_RADIUS_MILES) return 'houston';
    if (TRISTATE_ANCHORS.some((a) => miles([lat, lng], a.ll) <= a.radius + 3)) return 'ny_tristate';
    return null;
  }
  const st = listingContext.usStateCode(row.state);
  if (st === 'TX' && HOUSTON_CITIES.has(String(row.city || '').trim().toLowerCase())) return 'houston';
  return null;
}

function businessType(row) {
  const prof = row.bd_metadata && row.bd_metadata.profession_id != null ? String(row.bd_metadata.profession_id) : null;
  if (prof === '4') return 'estate_sale_company';
  if (/liquidat/i.test(row.name || '')) return 'liquidator';
  if (prof === '3') return 'auction_house';
  if (prof === '5') return 'appraiser';
  return null;
}

const tierFor = (score) => (score >= 60 ? 'A' : score >= 40 ? 'B' : 'C');

/**
 * Score one listing. Pure given (entity, ctx, mx): `mx` = Map(domain -> boolean) of MX lookups already
 * performed (missing = unknown = 0 points).
 */
function scoreListing(entity, ctx, mx = new Map()) {
  const w = Object.assign({}, DEFAULT_WEIGHTS, ctx.config.weights || {});
  const o = entity.row;
  const cluster = ctx.snap.clusterFor('organization', entity.entity_id);
  const prospects = cluster ? cluster.members.filter((m) => m.entity_type === 'sales_prospect').map((m) => m.row) : [];
  const f = {};
  const market = strategicMarket(o);
  f.strategic_market = market ? { points: w.strategic_market, value: market } : { points: 0, value: null };
  const type = businessType(o);
  f.business_type = type ? { points: w[type] || 0, value: type } : { points: 0, value: null };
  f.operating = { points: 0, value: 'unknown' };
  f.reputation = { points: 0, value: 'unknown' };
  const websiteStatus = prospects.map((p) => p.website_status).find((s) => s && s !== 'unknown') || null;
  if (!o.website_url || ['none', 'social_only'].includes(websiteStatus)) f.web_presence = { points: w.no_website, value: o.website_url ? websiteStatus : 'no website' };
  else if (['basic', 'outdated'].includes(websiteStatus)) f.web_presence = { points: w.basic_website, value: websiteStatus };
  else f.web_presence = { points: 0, value: websiteStatus || 'website listed' };
  f.no_online_auctions = prospects.some((p) => p.online_auctions_offered === 'no') ? { points: w.no_online_auctions, value: 'no' } : { points: 0, value: 'unknown' };
  const dom = seg.emailDomain(normalizeEmail(o.contact_email || ''));
  const corp = identity.isIdentityDomain(dom) ? dom : null;
  f.corporate_email = corp && mx.get(corp) === true ? { points: w.corporate_email, value: corp } : { points: 0, value: corp ? (mx.has(corp) ? 'no MX' : 'unchecked') : 'free mailbox' };
  f.large_firm_named_employee = o.bd_listing_id && ctx.config.excludedBdIds.has(String(o.bd_listing_id))
    ? { points: w.large_firm_named_employee, value: true } : { points: 0, value: false };
  const score = Math.max(0, Object.values(f).reduce((s, x) => s + (Number(x.points) || 0), 0));
  return { score, tier: tierFor(score), factors: f };
}

/** Resolve MX for corporate listing domains, bounded and cached per run. Unknown on error/timeout. */
async function mxLookups(domains, { timeoutMs = 2500, resolver = dns.resolveMx } = {}) {
  const out = new Map();
  await Promise.all([...new Set(domains)].map(async (d) => {
    try {
      const r = await Promise.race([resolver(d), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
      out.set(d, Array.isArray(r) && r.length > 0);
    } catch (e) { if (e && /ENOTFOUND|ENODATA/.test(e.code || e.message || '')) out.set(d, false); }
  }));
  return out;
}

async function scoreAll({ persist = true, runner = db, ctx = null, checkMx = true } = {}) {
  const c = ctx || (await listingContext.load(runner));
  const domains = c.listings.map((e) => seg.emailDomain(normalizeEmail(e.row.contact_email || ''))).filter((d) => identity.isIdentityDomain(d));
  const mx = checkMx ? await mxLookups(domains) : new Map();
  const rows = [];
  for (const e of c.listings) {
    const s = scoreListing(e, c, mx);
    const cluster = c.snap.clusterFor('organization', e.entity_id);
    rows.push({ organization_id: e.entity_id, company_name: e.label, ...s });
    if (persist) {
      await runner.query(
        `INSERT INTO listing_outreach_scores (organization_id, company_id, score, tier, factors, scored_at)
         VALUES ($1,$2,$3,$4,$5::jsonb, now())
         ON CONFLICT (organization_id) DO UPDATE SET company_id = EXCLUDED.company_id, score = EXCLUDED.score,
           tier = EXCLUDED.tier, factors = EXCLUDED.factors, scored_at = now()`,
        [e.entity_id, c.companyIdOf(cluster), s.score, s.tier, JSON.stringify(s.factors)]);
    }
  }
  const tiers = rows.reduce((m, r) => { m[r.tier] = (m[r.tier] || 0) + 1; return m; }, {});
  return { scored: rows.length, tiers, rows };
}

module.exports = { DEFAULT_WEIGHTS, strategicMarket, businessType, tierFor, scoreListing, mxLookups, scoreAll };
