'use strict';

/**
 * providerReconciliationService — provider-reported conversions vs first-party outcomes (Phase 3P.2).
 * First-party truth is authoritative. Discrepancies are RECORDED per provider / campaign / window with both numbers
 * side by side — never averaged, never "corrected" toward the provider. Platform-reported conversions stay
 * provisional until reconciled (paid-growth-policy anti-overreaction rule).
 */
const db = require('../../db');
const defs = require('../../lib/conversionDefinitions');
const { normalizeCampaignKey } = require('../../lib/paidCampaignKey');

/** Pure comparison. provider/firstParty = { conversion_key: count }. */
function compare(provider = {}, firstParty = {}) {
  const keys = new Set([...Object.keys(provider), ...Object.keys(firstParty)]);
  const out = {};
  for (const k of keys) {
    const p = Number(provider[k] || 0), f = Number(firstParty[k] || 0);
    out[k] = { provider: p, first_party: f, difference: p - f, ratio: f > 0 ? Math.round((p / f) * 100) / 100 : null,
      status: p === f ? 'MATCH' : (f === 0 ? 'PROVIDER_ONLY' : (p === 0 ? 'FIRST_PARTY_ONLY' : (p > f ? 'PROVIDER_OVER' : 'PROVIDER_UNDER'))) };
  }
  return out;
}

async function reconcile({ provider, campaignKey, windowStart, windowEnd, note = null } = {}, runner) {
  const r = runner || db;
  // Stored keys may be legacy spellings of the same campaign ("facebook:adv_—_<key>", "meta:<key>"): read the window
  // and match on the canonical campaign_key (src/lib/paidCampaignKey.js).
  campaignKey = normalizeCampaignKey(campaignKey);
  const prov = (await r.query(
    `SELECT campaign_key, provider_conversions FROM marketing_paid_cost_facts WHERE provider=$1 AND fact_date BETWEEN $2 AND $3`,
    [provider, windowStart, windowEnd])).rows.filter((row) => normalizeCampaignKey(row.campaign_key) === campaignKey);
  const providerTotals = {};
  for (const row of prov) for (const [k, v] of Object.entries(row.provider_conversions || {})) providerTotals[k] = (providerTotals[k] || 0) + Number(v || 0);
  const fpRows = (await r.query(
    `SELECT COALESCE(attribution->'last_paid_touch'->>'campaign_key', '') paid_key, COALESCE(attribution->'last_touch'->>'campaign_key', '') last_key,
            conversion_key, count(*)::int n FROM marketing_conversion_events
      WHERE occurred_at >= $1::date AND occurred_at < ($2::date + 1)
        AND (attribution->'last_paid_touch'->>'campaign_key' IS NOT NULL OR attribution->'last_touch'->>'campaign_key' IS NOT NULL)
      GROUP BY 1, 2, 3`, [windowStart, windowEnd])).rows;
  const fpMap = {};
  for (const x of fpRows) {
    if (normalizeCampaignKey(x.paid_key) !== campaignKey && normalizeCampaignKey(x.last_key) !== campaignKey) continue;
    fpMap[x.conversion_key] = (fpMap[x.conversion_key] || 0) + x.n;
  }
  const fp = Object.entries(fpMap).map(([conversion_key, n]) => ({ conversion_key, n }));
  // Meta reports by standard event name (CompleteRegistration, Lead, …): fold first-party keys onto the same names so the
  // comparison is like-for-like; other providers compare by conversion key.
  const firstParty = {};
  for (const x of fp) {
    if (!defs.get(x.conversion_key)) continue;
    const k = provider === 'meta_ads' ? (defs.metaEventFor(x.conversion_key) || x.conversion_key) : x.conversion_key;
    firstParty[k] = (firstParty[k] || 0) + x.n;
  }
  const discrepancy = compare(providerTotals, firstParty);
  const ins = await r.query(
    `INSERT INTO marketing_provider_reconciliations (provider, campaign_key, window_start, window_end, provider_reported, first_party, discrepancy, note)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8) RETURNING id, created_at`,
    [provider, campaignKey, windowStart, windowEnd, JSON.stringify(providerTotals), JSON.stringify(firstParty), JSON.stringify(discrepancy), note]);
  return { id: ins.rows[0].id, provider, campaign_key: campaignKey, provider_reported: providerTotals, first_party: firstParty, discrepancy };
}

module.exports = { compare, reconcile };
