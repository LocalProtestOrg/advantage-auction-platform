'use strict';

/**
 * paidCostIngestionService — daily campaign cost facts from Meta Ads / Google Ads (Phase 3P.2 cost_ingestion).
 *
 *   ingest(provider, rows)  normalise + upsert provider rows into marketing_paid_cost_facts (one row per provider /
 *                           campaign / ad set / ad / day; re-ingesting a day REPLACES that day's numbers — providers
 *                           restate recent days), then mirror the per-campaign day total into marketing_performance_facts
 *                           (purchase_kind 'paid_growth', metric 'paid_spend_cents', classification DELIVERED) so the
 *                           Director reads cost next to outcomes. Paid-growth facts never carry a Marketing Package id.
 *   pull(provider, range)   the provider API puller. REFUSES while its READ gate is OFF or the account identity is
 *                           unverified. Meta: marketing.measurement.meta_cost_ingestion_enabled (a READ-ONLY gate —
 *                           separate from the paid-ads gate, which stays OFF); Google: not connected.
 *   pullMeta(range)         READ-ONLY Meta Ads Insights (spend / impressions / clicks / actions per ad per day) for the
 *                           Graph-verified Advantage.Bid ad account, with META_ADS_READ_TOKEN (ads_read). It never creates,
 *                           edits, starts or pays for anything. Each run is recorded as verification evidence.
 * campaign_key joins cost ↔ first-party outcomes: '<utm_source>:<utm_campaign>' — the same key attributionService builds
 * from the landing UTM, so every ad's final URL must carry utm_source + utm_campaign (a launch checklist item).
 */
const db = require('../../db');

const PROVIDERS = { meta_ads: { gate: 'marketing.measurement.meta_cost_ingestion_enabled', utm_source: 'facebook' }, google_ads: { gate: 'marketing.destinations.google_ads_enabled', utm_source: 'google' } };
// Meta Insights action types → the Meta standard event names our conversion definitions map to (reconciliation joins on these).
const META_ACTIONS = {
  'offsite_conversion.fb_pixel_complete_registration': 'CompleteRegistration', complete_registration: 'CompleteRegistration',
  'offsite_conversion.fb_pixel_lead': 'Lead', lead: 'Lead', 'offsite_conversion.fb_pixel_purchase': 'Purchase', purchase: 'Purchase',
  'offsite_conversion.fb_pixel_add_to_wishlist': 'AddToWishlist', 'offsite_conversion.fb_pixel_add_to_cart': 'AddToCart',
  'offsite_conversion.fb_pixel_subscribe': 'Subscribe', 'offsite_conversion.fb_pixel_start_trial': 'StartTrial', 'offsite_conversion.fb_pixel_submit_application': 'SubmitApplication',
};
const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0; };

function campaignKeyFor(provider, row) {
  if (row.campaign_key) return String(row.campaign_key).toLowerCase().slice(0, 160);
  const src = (row.utm_source || PROVIDERS[provider].utm_source).toLowerCase();
  // Convention: an ad's landing URL carries utm_campaign = its campaign name, so cost and sessions share one key.
  const camp = row.utm_campaign || row.campaign_name || row.campaign_id;
  return (src + ':' + String(camp).trim().toLowerCase().replace(/\s+/g, '_')).slice(0, 160);
}

function normalise(provider, row) {
  if (!PROVIDERS[provider]) throw new Error('unknown provider ' + provider);
  if (!row || !row.campaign_id || !row.date) return null;
  const date = String(row.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // spend may arrive in currency units (provider APIs) or cents (manual import) — callers say which.
  const spendCents = row.spend_cents != null ? int(row.spend_cents) : int(Number(row.spend || 0) * 100);
  const optInt = (v) => (v === undefined || v === null || v === '' ? null : int(v));
  return { provider, account_ref: row.account_ref || null, campaign_id: String(row.campaign_id), campaign_name: row.campaign_name || null, campaign_key: campaignKeyFor(provider, row),
    adset_id: String(row.adset_id || ''), ad_id: String(row.ad_id || ''), fact_date: date, spend_cents: spendCents, impressions: int(row.impressions), clicks: int(row.clicks),
    provider_conversions: row.provider_conversions && typeof row.provider_conversions === 'object' ? row.provider_conversions : {},
    adset_name: row.adset_name || null, ad_name: row.ad_name || null, creative_id: row.creative_id ? String(row.creative_id) : null,
    reach: optInt(row.reach), link_clicks: optInt(row.link_clicks),
    provider_metrics: row.provider_metrics && typeof row.provider_metrics === 'object' ? row.provider_metrics : {} };
}

async function excludedAccounts(r) {
  try { const x = (await r.query(`SELECT value FROM platform_config WHERE key='marketing.measurement.meta_ad_account_excluded'`)).rows[0]; return x && Array.isArray(x.value) ? x.value : []; }
  catch (_) { return []; }
}

async function ingest(provider, rows, runner) {
  const r = runner || db;
  const out = { provider, received: (rows || []).length, upserted: 0, invalid: 0, excluded: 0, campaigns: new Set(), days: new Set() };
  // Owner-excluded accounts are never ingested, whatever path the rows came from (belt and braces behind pullMeta).
  const excluded = provider === 'meta_ads' ? await excludedAccounts(r) : [];
  for (const raw of rows || []) {
    const n = normalise(provider, raw);
    if (!n) { out.invalid += 1; continue; }
    if (n.account_ref && require('./assetIdentityGuard').isExcluded(n.account_ref, excluded)) { out.excluded += 1; continue; }
    await r.query(
      `INSERT INTO marketing_paid_cost_facts (provider, account_ref, campaign_id, campaign_name, campaign_key, adset_id, ad_id, fact_date, spend_cents, impressions, clicks, provider_conversions,
         adset_name, ad_name, creative_id, reach, link_clicks, provider_metrics)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18::jsonb)
       ON CONFLICT (provider, campaign_id, adset_id, ad_id, fact_date) DO UPDATE SET
         account_ref = EXCLUDED.account_ref, campaign_name = EXCLUDED.campaign_name, campaign_key = EXCLUDED.campaign_key, spend_cents = EXCLUDED.spend_cents,
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, provider_conversions = EXCLUDED.provider_conversions,
         adset_name = EXCLUDED.adset_name, ad_name = EXCLUDED.ad_name, creative_id = COALESCE(EXCLUDED.creative_id, marketing_paid_cost_facts.creative_id),
         reach = EXCLUDED.reach, link_clicks = EXCLUDED.link_clicks, provider_metrics = EXCLUDED.provider_metrics, ingested_at = now()`,
      [n.provider, n.account_ref, n.campaign_id, n.campaign_name, n.campaign_key, n.adset_id, n.ad_id, n.fact_date, n.spend_cents, n.impressions, n.clicks, JSON.stringify(n.provider_conversions),
       n.adset_name, n.ad_name, n.creative_id, n.reach, n.link_clicks, JSON.stringify(n.provider_metrics)]);
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

async function pull(provider, range = {}, runner) {
  const p = PROVIDERS[provider]; if (!p) throw new Error('unknown provider ' + provider);
  let gate = null; try { gate = await require('../configService').get(null, p.gate); } catch (_) { gate = null; }
  if (!(gate === true || gate === 'true')) return { pulled: false, reason: 'GATED_OFF', detail: p.gate + ' is OFF — no provider call made' };
  if (provider === 'meta_ads') return pullMeta(range, runner);
  return { pulled: false, reason: 'NOT_CONNECTED', detail: 'provider reporting access is an Owner activation step; nothing is pulled until the account identity is verified' };
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const metaTokenPresent = () => Boolean(process.env.META_ADS_READ_TOKEN && String(process.env.META_ADS_READ_TOKEN).length > 20);

// The Insights fields the Director measures (level=ad, one row per ad per day). All READ-ONLY.
const META_INSIGHT_FIELDS = ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'ctr', 'cpc', 'cpm', 'actions', 'date_start', 'date_stop'];

/** Map one Insights row (level=ad, time_increment=1) to an ingest row. Pure. creatives: { ad_id: creative_id }. */
function metaInsightToRow(x, accountId, creatives = {}) {
  const conv = {}; const actions = {};
  for (const a of x.actions || []) {
    const n = Number(a.value || 0); actions[a.action_type] = (actions[a.action_type] || 0) + n;
    const ev = META_ACTIONS[a.action_type]; if (ev) conv[ev] = (conv[ev] || 0) + n;
  }
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return { campaign_id: x.campaign_id, campaign_name: x.campaign_name || null, adset_id: x.adset_id || '', adset_name: x.adset_name || null, ad_id: x.ad_id || '', ad_name: x.ad_name || null,
    creative_id: creatives[x.ad_id] || null, date: x.date_start,
    spend: Number(x.spend || 0), impressions: Number(x.impressions || 0), reach: num(x.reach), clicks: Number(x.clicks || 0), link_clicks: num(x.inline_link_clicks),
    provider_conversions: conv, provider_metrics: { ctr: num(x.ctr), cpc: num(x.cpc), cpm: num(x.cpm), actions }, account_ref: accountId };
}

/** Director grain: exact ratios derived from summed facts (never averaged ratios). Pure. */
function derivedMetrics({ spend_cents = 0, impressions = 0, clicks = 0, link_clicks = null } = {}) {
  const r2 = (v) => Math.round(v * 100) / 100;
  return { ctr_pct: impressions > 0 ? r2((clicks / impressions) * 100) : null, link_ctr_pct: impressions > 0 && link_clicks != null ? r2((link_clicks / impressions) * 100) : null,
    cpc_usd: clicks > 0 ? r2(spend_cents / 100 / clicks) : null, cost_per_link_click_usd: link_clicks > 0 ? r2(spend_cents / 100 / link_clicks) : null,
    cpm_usd: impressions > 0 ? r2((spend_cents / 100 / impressions) * 1000) : null };
}

/** READ-ONLY ad → creative map for an ad account (paged). */
async function metaCreativeMap(act, token, V) {
  const map = {}; let url = 'https://graph.facebook.com/' + V + '/' + act + '/ads?fields=id,creative{id}&limit=500'; let pages = 0;
  while (url && pages < 20) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    let j = null; try { j = await res.json(); } catch (_) { j = null; }
    if (!res.ok || !j || j.error) break;
    for (const a of j.data || []) if (a.creative && a.creative.id) map[a.id] = a.creative.id;
    url = j.paging && j.paging.next ? j.paging.next : null; pages += 1;
  }
  return map;
}

async function recordEvidence(r, patch) {
  try {
    await r.query(`UPDATE platform_config SET value = COALESCE(value, '{}'::jsonb) || $1::jsonb, updated_at = now() WHERE key = 'marketing.measurement.meta_verification'`, [JSON.stringify(patch)]);
  } catch (_) { /* evidence is best-effort */ }
}

async function pullMeta({ since = null, until = null } = {}, runner) {
  const r = runner || db;
  const cfg = async (k) => { const x = await r.query(`SELECT value FROM platform_config WHERE key=$1`, [k]); return x.rows[0] ? x.rows[0].value : null; };
  const accountId = await cfg('marketing.measurement.meta_ad_account_id');
  const guardMod = require('./assetIdentityGuard');
  if (guardMod.isExcluded(accountId, await excludedAccounts(r))) return { pulled: false, reason: 'EXCLUDED_BY_OWNER', detail: 'the configured ad account is on the Owner exclusion list — never pulled' };
  const id = guardMod.check('meta_ad_account', accountId, await cfg('marketing.measurement.meta_ad_account_identity'));
  if (!id.ok) return { pulled: false, reason: id.reason, detail: id.detail };
  if (!metaTokenPresent()) return { pulled: false, reason: 'TOKEN_ABSENT', detail: 'META_ADS_READ_TOKEN is not set (presence check only)' };
  const V = process.env.META_GRAPH_VERSION || 'v21.0';
  const until_ = until || ymd(Date.now() - 86400000); const since_ = since || ymd(new Date(until_).getTime() - 2 * 86400000);
  const act = String(accountId).startsWith('act_') ? String(accountId) : 'act_' + accountId;
  const fields = META_INSIGHT_FIELDS.join(',');
  let url = 'https://graph.facebook.com/' + V + '/' + act + '/insights?level=ad&time_increment=1&limit=500&fields=' + fields + '&time_range=' + encodeURIComponent(JSON.stringify({ since: since_, until: until_ }));
  const rows = []; let pages = 0;
  while (url && pages < 50) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.META_ADS_READ_TOKEN } });
    let j = null; try { j = await res.json(); } catch (_) { j = null; }
    if (!res.ok || !j || j.error) {
      const msg = String((j && j.error && j.error.message) || ('HTTP ' + res.status)).split(process.env.META_ADS_READ_TOKEN || '\u0000').join('[credential]').slice(0, 200);
      await recordEvidence(r, { cost: { at: new Date().toISOString(), ok: false, account_id: act, since: since_, until: until_, error: msg } });
      return { pulled: false, reason: 'PROVIDER_ERROR', detail: msg };
    }
    for (const x of j.data || []) rows.push(x);
    url = j.paging && j.paging.next ? j.paging.next.replace(/access_token=[^&]+&?/, '') : null; pages += 1;
  }
  const creatives = rows.length ? await metaCreativeMap(act, process.env.META_ADS_READ_TOKEN, V) : {};
  const mapped = rows.map((x) => metaInsightToRow(x, act, creatives));
  const out = await ingest('meta_ads', mapped, r);
  const spend = mapped.reduce((a, x) => a + Math.round(x.spend * 100), 0);
  await recordEvidence(r, { cost: { at: new Date().toISOString(), ok: true, account_id: act, since: since_, until: until_, rows: mapped.length, spend_cents: spend, upserted: out.upserted, fields: META_INSIGHT_FIELDS } });
  return { pulled: true, account_id: act, since: since_, until: until_, rows: mapped.length, spend_cents: spend, upserted: out.upserted };
}

async function spendSummary({ from, to } = {}, runner) {
  const r = runner || db;
  const q = await r.query(
    `SELECT provider, campaign_key, COALESCE(SUM(spend_cents),0)::bigint spend_cents, COALESCE(SUM(impressions),0)::bigint impressions, COALESCE(SUM(clicks),0)::bigint clicks
       FROM marketing_paid_cost_facts WHERE ($1::date IS NULL OR fact_date >= $1) AND ($2::date IS NULL OR fact_date <= $2)
      GROUP BY provider, campaign_key ORDER BY spend_cents DESC`, [from || null, to || null]);
  return q.rows.map((x) => ({ ...x, spend_cents: Number(x.spend_cents), impressions: Number(x.impressions), clicks: Number(x.clicks) }));
}

module.exports = { ingest, pull, pullMeta, metaInsightToRow, metaCreativeMap, derivedMetrics, normalise, campaignKeyFor, spendSummary, PROVIDERS, META_ACTIONS, META_INSIGHT_FIELDS };
