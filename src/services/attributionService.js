'use strict';

/**
 * attributionService — first-party campaign/session attribution (Phase 3P.2 measurement readiness).
 *
 *   recordTouch   landing capture: landing URL, referrer, UTM (source/medium/campaign/content/term), click ids
 *                 (gclid/gbraid/wbraid/fbclid — raw values stay in marketing_click_ids; here only type + hash), consent
 *                 snapshot → marketing_attribution_touches; the visitor profile keeps first / last / last-paid touch.
 *   stitch        anonymous → known on an authoritative action (register / login / subscribe / seller signup): the
 *                 visitor's touches inside the 90-day look-back are attributed to the user; conversions recorded before
 *                 the stitch keep their snapshot, later ones read the stitched profile. Explicit, never speculative.
 *   snapshot      the attribution a conversion carries (first / last / last-paid touch + class).
 * Policy (anonymous-to-known): docs/marketing/measurement/anonymous-to-known-attribution-policy.md. First-party
 * operational measurement; nothing here sends anything to an advertising platform.
 */
const crypto = require('crypto');
const db = require('../db');

const LOOKBACK_DAYS = 90;
const PAID_MEDIUMS = /^(cpc|ppc|paid|paid_social|paidsocial|cpm|display|paid-social|paid_search|sponsored)$/i;
const SOCIAL_HOSTS = /(facebook\.com|instagram\.com|l\.facebook\.com|lm\.facebook\.com|t\.co|twitter\.com|x\.com|pinterest\.|linkedin\.com|tiktok\.com|nextdoor\.com)/i;
const SEARCH_HOSTS = /(google\.|bing\.com|duckduckgo\.com|yahoo\.com|ecosia\.org)/i;
const OWN_HOSTS = /(^|\.)advantage\.bid$/i;

const clip = (v, n = 200) => (v == null ? null : String(v).trim().slice(0, n) || null);
const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (_) { return null; } };
const pathOf = (u) => { try { return new URL(u).pathname.slice(0, 300); } catch (_) { return null; } };

function parseParams(url) {
  const out = {}; try { const q = new URL(url).searchParams; for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid', 'fbclid']) { const v = q.get(k); if (v) out[k] = v; } } catch (_) { /* bad URL → no params */ }
  return out;
}

/** Channel from click ids / UTM / referrer (deterministic, explainable). */
function classifyChannel({ utm = {}, clickType = null, referrerHost = null }) {
  if (clickType === 'fbclid' && (PAID_MEDIUMS.test(utm.utm_medium || '') || /paid/i.test(utm.utm_medium || ''))) return 'paid_social';
  if (['gclid', 'gbraid', 'wbraid'].includes(clickType)) return 'paid_search';
  if (utm.utm_medium && PAID_MEDIUMS.test(utm.utm_medium)) return /facebook|instagram|meta|fb|ig/i.test(utm.utm_source || '') ? 'paid_social' : 'paid_search';
  if (utm.utm_medium && /email|newsletter/i.test(utm.utm_medium)) return 'email';
  if (clickType === 'fbclid') return 'organic_social';
  if (utm.utm_source && /facebook|instagram|meta|fb|ig|social/i.test(utm.utm_source)) return 'organic_social';
  if (referrerHost && !OWN_HOSTS.test(referrerHost)) {
    if (SOCIAL_HOSTS.test(referrerHost)) return 'organic_social';
    if (SEARCH_HOSTS.test(referrerHost)) return 'organic_search';
    return 'referral';
  }
  return 'direct';
}
const isPaid = (ch) => ch === 'paid_social' || ch === 'paid_search';

function campaignKey({ utm = {}, channel }) {
  // Normalised the same way as the cost side (paidCostIngestionService.campaignKeyFor): lower case, whitespace → '_'.
  if (utm.utm_campaign) return (String(utm.utm_source || 'unknown').toLowerCase() + ':' + String(utm.utm_campaign).trim().toLowerCase().replace(/\s+/g, '_')).slice(0, 160);
  return isPaid(channel) ? channel + ':unlabelled' : null;
}

async function recordTouch({ visitorId, sessionId = null, landingUrl, referrer = null, consentState = null, at = null } = {}, runner) {
  const r = runner || db;
  const vid = clip(visitorId, 64); if (!vid || !landingUrl) return null;
  const params = parseParams(landingUrl);
  const clickType = ['gclid', 'gbraid', 'wbraid', 'fbclid'].find((t) => params[t]) || null;
  const refHost = referrer ? host(referrer) : null;
  const utm = { utm_source: clip(params.utm_source, 120), utm_medium: clip(params.utm_medium, 60), utm_campaign: clip(params.utm_campaign, 160), utm_content: clip(params.utm_content, 160), utm_term: clip(params.utm_term, 160) };
  const channel = classifyChannel({ utm, clickType, referrerHost: refHost });
  // Only campaign-bearing or external arrivals are touches; internal navigation is not a new touch.
  if (channel === 'direct' && !Object.values(utm).some(Boolean) && !clickType) return null;
  const ck = campaignKey({ utm, channel });
  const hour = new Date(at || Date.now()).toISOString().slice(0, 13);
  const dedup = crypto.createHash('sha256').update([vid, sessionId || '', ck || channel, clickType ? params[clickType] : '', hour].join('|')).digest('hex');
  const ins = await r.query(`INSERT INTO marketing_attribution_touches (visitor_id, session_id, touched_at, landing_host, landing_path, referrer_host, channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_type, click_value_sha256, campaign_key, consent_state, dedup_key)
      VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
      ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [vid, clip(sessionId, 64), at, host(landingUrl), pathOf(landingUrl), refHost, channel, utm.utm_source, utm.utm_medium, utm.utm_campaign, utm.utm_content, utm.utm_term, clickType,
     clickType ? crypto.createHash('sha256').update(String(params[clickType])).digest('hex') : null, ck, consentState ? JSON.stringify(consentState) : null, dedup]);
  if (!ins.rows.length) return { deduped: true };
  const id = ins.rows[0].id;
  await r.query(`INSERT INTO marketing_attribution_profiles (visitor_id, first_touch_id, last_touch_id, last_paid_touch_id) VALUES ($1,$2,$2,$3)
      ON CONFLICT (visitor_id) DO UPDATE SET last_touch_id = EXCLUDED.last_touch_id,
        last_paid_touch_id = COALESCE(EXCLUDED.last_paid_touch_id, marketing_attribution_profiles.last_paid_touch_id), updated_at = now()`, [vid, id, isPaid(channel) ? id : null]);
  return { id, channel, campaign_key: ck, click_type: clickType };
}

async function stitch({ visitorId, userId, source = 'login' } = {}, runner) {
  const r = runner || db;
  if (!visitorId || !userId) return null;
  await r.query(`INSERT INTO marketing_attribution_profiles (visitor_id, user_id, stitched_at) VALUES ($1,$2,now())
      ON CONFLICT (visitor_id) DO UPDATE SET user_id = COALESCE(marketing_attribution_profiles.user_id, EXCLUDED.user_id), stitched_at = COALESCE(marketing_attribution_profiles.stitched_at, now()), updated_at = now()`, [visitorId, userId]);
  const t = await r.query(`UPDATE marketing_attribution_touches SET user_id = $2 WHERE visitor_id = $1 AND user_id IS NULL AND touched_at > now() - ($3 || ' days')::interval`, [visitorId, userId, String(LOOKBACK_DAYS)]);
  return { touches_attributed: t.rowCount, source };
}

async function touchRow(r, id) { if (!id) return null; const x = (await r.query(`SELECT id, touched_at, channel, campaign_key, utm_source, utm_medium, utm_campaign, click_type FROM marketing_attribution_touches WHERE id=$1`, [id])).rows[0]; return x || null; }

/** Attribution a conversion carries. Class: MEASURED (a paid/campaign touch inside the look-back) · INFLUENCED (a
 *  campaign touch outside the window, or organic last touch after a paid one) · ATTRIBUTION_UNAVAILABLE (no touches). */
async function snapshot({ userId = null, visitorId = null } = {}, runner) {
  const r = runner || db;
  let prof = null;
  if (visitorId) prof = (await r.query(`SELECT * FROM marketing_attribution_profiles WHERE visitor_id=$1`, [visitorId])).rows[0] || null;
  if (!prof && userId) prof = (await r.query(`SELECT * FROM marketing_attribution_profiles WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1`, [userId])).rows[0] || null;
  if (!prof) return { class: 'ATTRIBUTION_UNAVAILABLE', reason: 'no first-party touch for this visitor/user' };
  const [first, last, lastPaid] = await Promise.all([touchRow(r, prof.first_touch_id), touchRow(r, prof.last_touch_id), touchRow(r, prof.last_paid_touch_id)]);
  const inWindow = (t) => t && (Date.now() - new Date(t.touched_at).getTime()) <= LOOKBACK_DAYS * 86400000;
  const cls = inWindow(lastPaid) || (inWindow(last) && last.campaign_key) ? 'MEASURED' : ((first && first.campaign_key) || lastPaid ? 'INFLUENCED' : 'ATTRIBUTION_UNAVAILABLE');
  return { class: cls, first_touch: first, last_touch: last, last_paid_touch: lastPaid, visitor_id: prof.visitor_id, lookback_days: LOOKBACK_DAYS };
}

/** Retention purge (anonymous-to-known policy §5): touches older than `months` (default 13). Maintenance path only. */
async function purgeExpired(months = 13, runner) {
  const r = runner || db;
  const res = await r.query(`DELETE FROM marketing_attribution_touches WHERE touched_at < now() - ($1 || ' months')::interval`, [String(months)]);
  return res.rowCount;
}

module.exports = { recordTouch, stitch, snapshot, classifyChannel, campaignKey, parseParams, purgeExpired, LOOKBACK_DAYS };
