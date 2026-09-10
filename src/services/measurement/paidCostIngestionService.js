'use strict';

/**
 * paidCostIngestionService — daily campaign cost facts from Meta Ads / Google Ads (Phase 3P.2 cost_ingestion).
 *
 *   ingest(provider, rows)  normalise + upsert provider rows into marketing_paid_cost_facts (one row per provider /
 *                           campaign / ad set / ad / day; re-ingesting a day REPLACES that day's numbers — providers
 *                           restate recent days), then mirror the per-campaign day total into marketing_performance_facts
 *                           (purchase_kind 'paid_growth', metric 'paid_spend_cents', classification DELIVERED) so the
 *                           Director reads cost next to outcomes. Paid-growth facts never carry a Marketing Package id.
 *   pull(provider, range)   the provider API puller. REFUSES while the channel's Owner gate is OFF
 *                           (marketing.destinations.meta_ads_enabled / google_ads_enabled) or the account identity is
 *                           unverified — no provider call is made in this phase.
 * campaign_key joins cost ↔ first-party outcomes: '<utm_source>:<utm_campaign>' — the same key attributionService builds
 * from the landing UTM, so every ad's final URL must carry utm_source + utm_campaign (a launch checklist item).
 */
const db = require('../../db');

const PROVIDERS = { meta_ads: { gate: 'marketing.destinations.meta_ads_enabled', utm_source: 'facebook' }, google_ads: { gate: 'marketing.destinations.google_ads_enabled', utm_source: 'google' } };
const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0; };

function campaignKeyFor(provider, row) {
  if (row.campaign_key) return String(row.campaign_key).toLowerCase().slice(0, 160);
  const src = (row.utm_source || PROVIDERS[provider].utm_source).toLowerCase();
  const camp = row.utm_campaign || row.campaign_name || row.campaign_id;
  return (src + ':' + String(camp).toLowerCase()).slice(0, 160);
}

function normalise(provider, row) {
  if (!PROVIDERS[provider]) throw new Error('unknown provider ' + provider);
  if (!row || !row.campaign_id || !row.date) return null;
  const date = String(row.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // spend may arrive in currency units (provider APIs) or cents (manual import) — callers say which.
  const spendCents = row.spend_cents != null ? int(row.spend_cents) : int(Number(row.spend || 0) * 100);
  return { provider, account_ref: row.account_ref || null, campaign_id: String(row.campaign_id), campaign_name: row.campaign_name || null, campaign_key: campaignKeyFor(provider, row),
    adset_id: String(row.adset_id || ''), ad_id: String(row.ad_id || ''), fact_date: date, spend_cents: spendCents, impressions: int(row.impressions), clicks: int(row.clicks),
    provider_conversions: row.provider_conversions && typeof row.provider_conversions === 'object' ? row.provider_conversions : {} };
}

async function ingest(provider, rows, runner) {
  const r = runner || db;
  const out = { provider, received: (rows || []).length, upserted: 0, invalid: 0, campaigns: new Set(), days: new Set() };
  for (const raw of rows || []) {
    const n = normalise(provider, raw);
    if (!n) { out.invalid += 1; continue; }
    await r.query(
      `INSERT INTO marketing_paid_cost_facts (provider, account_ref, campaign_id, campaign_name, campaign_key, adset_id, ad_id, fact_date, spend_cents, impressions, clicks, provider_conversions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT (provider, campaign_id, adset_id, ad_id, fact_date) DO UPDATE SET
         account_ref = EXCLUDED.account_ref, campaign_name = EXCLUDED.campaign_name, campaign_key = EXCLUDED.campaign_key, spend_cents = EXCLUDED.spend_cents,
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, provider_conversions = EXCLUDED.provider_conversions, ingested_at = now()`,
      [n.provider, n.account_ref, n.campaign_id, n.campaign_name, n.campaign_key, n.adset_id, n.ad_id, n.fact_date, n.spend_cents, n.impressions, n.clicks, JSON.stringify(n.provider_conversions)]);
    out.upserted += 1; out.campaigns.add(n.campaign_key); out.days.add(n.fact_date);
  }
  // Mirror per-campaign day totals (replace, never double count).
  for (const ck of out.campaigns) for (const day of out.days) {
    const tot = (await r.query(`SELECT COALESCE(SUM(spend_cents),0)::bigint s FROM marketing_paid_cost_facts WHERE provider=$1 AND campaign_key=$2 AND fact_date=$3`, [provider, ck, day])).rows[0].s;
    const src = provider + ':' + ck + ':' + day;
    await r.query(`DELETE FROM marketing_performance_facts WHERE purchase_kind='paid_growth' AND metric='paid_spend_cents' AND source=$1`, [src]);
    if (Number(tot) > 0) await r.query(`INSERT INTO marketing_performance_facts (purchase_kind, purchase_id, metric, classification, value_numeric, source) VALUES ('paid_growth', NULL, 'paid_spend_cents', 'DELIVERED', $1, $2)`, [tot, src]);
  }
  return { ...out, campaigns: [...out.campaigns], days: [...out.days] };
}

async function pull(provider) {
  const p = PROVIDERS[provider]; if (!p) throw new Error('unknown provider ' + provider);
  let gate = null; try { gate = await require('../configService').get(null, p.gate); } catch (_) { gate = null; }
  if (!(gate === true || gate === 'true')) return { pulled: false, reason: 'GATED_OFF', detail: p.gate + ' is OFF — no provider call made' };
  return { pulled: false, reason: 'NOT_CONNECTED', detail: 'provider reporting access is an Owner activation step; nothing is pulled until the account identity is verified' };
}

async function spendSummary({ from, to } = {}, runner) {
  const r = runner || db;
  const q = await r.query(
    `SELECT provider, campaign_key, COALESCE(SUM(spend_cents),0)::bigint spend_cents, COALESCE(SUM(impressions),0)::bigint impressions, COALESCE(SUM(clicks),0)::bigint clicks
       FROM marketing_paid_cost_facts WHERE ($1::date IS NULL OR fact_date >= $1) AND ($2::date IS NULL OR fact_date <= $2)
      GROUP BY provider, campaign_key ORDER BY spend_cents DESC`, [from || null, to || null]);
  return q.rows.map((x) => ({ ...x, spend_cents: Number(x.spend_cents), impressions: Number(x.impressions), clicks: Number(x.clicks) }));
}

module.exports = { ingest, pull, normalise, campaignKeyFor, spendSummary, PROVIDERS };
