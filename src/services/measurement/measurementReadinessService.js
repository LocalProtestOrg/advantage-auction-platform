'use strict';

/**
 * measurementReadinessService — the eighteen-item paid-growth measurement readiness audit
 * (docs/marketing/phase3p2/config/measurement-readiness-audit.json), evaluated LIVE against the running deployment:
 * the deployed source files, the production schema, platform_config gates and first-party row counts.
 *
 * Status per item: VERIFIED (software present and wired; provider-side activation, if any, complete) · PARTIAL
 * (software present; something named in `gap` is missing — usually an Owner provider activation) · MISSING.
 * Nothing is assumed from behavioural intelligence or package fulfilment facts. Readiness rule sets are evaluated
 * exactly as the audit defines them; until the minimum set is VERIFIED the Director recommends $0.
 * Never reads or returns a secret — credential checks are presence-only booleans.
 */
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const defs = require('../../lib/conversionDefinitions');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return null; } };
const has = (rel, needle) => { const s = read(rel); return !!s && (needle ? s.includes(needle) : true); };

const RULES = {
  minimum_for_any_paid_activation: ['first_party_attribution', 'utm_capture', 'behavioral_events', 'conversion_definitions', 'cost_ingestion', 'consent', 'director_facts'],
  minimum_for_retargeting: ['retargeting_audiences', 'suppression', 'consent'],
  minimum_for_meta: ['meta_pixel', 'meta_capi', 'meta_click_id'],
  minimum_for_google: ['google_ads_conversion', 'google_click_ids'],
};
const REQUIRED_EVENTS = ['page_view', 'search', 'lot_view', 'watch_lot', 'bid', 'purchase', 'auction_draft_created', 'auction_published', 'seller_inquiry', 'assisted_service_inquiry', 'email_signup'];
// Where each server-side conversion is emitted (file must contain the emit call for the key).
const EMITTERS = {
  buyer_registered: 'src/routes/auth.js', seller_registered: 'src/routes/sellers.js', seller_inquiry: 'src/routes/sellers.js',
  auction_draft_created: 'src/routes/auctions.js', auction_published: 'src/services/auctionService.js', watch_lot: 'src/routes/watchlist.js',
  bid: 'src/services/bidService.js', purchase: 'src/services/combinedInvoiceService.js', email_signup: 'src/routes/publicSubscribe.js',
  assisted_service_inquiry: 'src/routes/publicAssistedService.js',
};

async function q(r, sql, p) { try { return (await r.query(sql, p)).rows; } catch (_) { return null; } }
async function tableExists(r, t) { const x = await q(r, `SELECT to_regclass($1) AS t`, ['public.' + t]); return !!(x && x[0] && x[0].t); }
async function count(r, sql, p) { const x = await q(r, sql, p); return x && x[0] ? Number(x[0].n) : null; }
async function cfg(r, key) { const x = await q(r, `SELECT value FROM platform_config WHERE key=$1`, [key]); return x && x[0] ? x[0].value : null; }
const on = (v) => v === true || v === 'true';

function item(key, status, evidence, gap, live) { return { key, status, evidence, gap: gap || null, live: live || {} }; }

async function evaluate(runner) {
  const r = runner || db;
  const meta = require('./metaCapiService');
  const google = require('./googleConversionsService');
  const guard = require('./assetIdentityGuard');
  const gates = {
    meta_pixel: on(await cfg(r, 'marketing.measurement.meta_pixel_enabled')), meta_capi: on(await cfg(r, 'marketing.measurement.meta_capi_enabled')),
    google_conversions: on(await cfg(r, 'marketing.measurement.google_conversions_enabled')), meta_ads: on(await cfg(r, 'marketing.destinations.meta_ads_enabled')),
    google_ads: on(await cfg(r, 'marketing.destinations.google_ads_enabled')),
  };
  const metaId = guard.check('meta_dataset', await cfg(r, 'marketing.measurement.meta_dataset_id'), await cfg(r, 'marketing.measurement.meta_dataset_identity'));
  const adAcctId = guard.check('meta_ad_account', await cfg(r, 'marketing.measurement.meta_ad_account_id'), await cfg(r, 'marketing.measurement.meta_ad_account_identity'));
  gates.meta_cost_ingestion = on(await cfg(r, 'marketing.measurement.meta_cost_ingestion_enabled'));
  // Evidence recorded by scripts/meta-measurement-connect.js verify (+ meta-browser-check.js). A Meta item is VERIFIED only
  // with fresh evidence of the real data path, never on configuration alone.
  const ev = (await cfg(r, 'marketing.measurement.meta_verification')) || {};
  const fresh = (e, days) => !!(e && e.ok && e.at && (Date.now() - new Date(e.at).getTime()) <= days * 86400000);
  const googleId = guard.check('google_ads_customer', await cfg(r, 'marketing.measurement.google_ads_customer_id'), await cfg(r, 'marketing.measurement.google_ads_customer_identity'));
  const tracker = read('public/widgets/shared/behavior-tracker.js') || '';
  const analyticsRoute = read('src/routes/analytics.js') || '';
  const loader = read('public/widgets/shared/ad-measurement.js');
  const live = {
    touches_30d: await count(r, `SELECT count(*)::int n FROM marketing_attribution_touches WHERE touched_at > now() - interval '30 days'`),
    campaign_touches_30d: await count(r, `SELECT count(*)::int n FROM marketing_attribution_touches WHERE campaign_key IS NOT NULL AND touched_at > now() - interval '30 days'`),
    stitched_profiles: await count(r, `SELECT count(*)::int n FROM marketing_attribution_profiles WHERE user_id IS NOT NULL`),
    click_ids: await q(r, `SELECT click_type, count(*)::int n FROM marketing_click_ids GROUP BY click_type ORDER BY click_type`),
    conversions_by_key: await q(r, `SELECT conversion_key, count(*)::int n FROM marketing_conversion_events GROUP BY conversion_key ORDER BY conversion_key`),
    consent_records: await count(r, `SELECT count(*)::int n FROM consent_records`),
    audience_members_active: await count(r, `SELECT count(*)::int n FROM marketing_audience_members WHERE exited_at IS NULL`),
    cost_fact_rows: await count(r, `SELECT count(*)::int n FROM marketing_paid_cost_facts`),
    reconciliations: await count(r, `SELECT count(*)::int n FROM marketing_provider_reconciliations`),
    page_views_7d: await count(r, `SELECT count(*)::int n FROM analytics_events WHERE event_type='page_view' AND received_at > now() - interval '7 days'`),
  };
  const items = [];

  // 1 meta_pixel — gate ON + Graph-verified Advantage.Bid dataset + real-browser evidence (PageView with consent, nothing without)
  const pixelOk = gates.meta_pixel && metaId.ok && fresh(ev.browser, 30);
  if (!loader) items.push(item('meta_pixel', 'MISSING', ['no consent-gated pixel loader'], 'build the loader'));
  else items.push(item('meta_pixel', pixelOk ? 'VERIFIED' : 'PARTIAL',
    ['public/widgets/shared/ad-measurement.js (consent-gated loader, PageView + eventID dedup)', 'GET /api/public/measurement-config (returns the dataset id only when the gate is ON and identity verified)', 'scripts/meta-browser-check.js (real-browser evidence)'],
    pixelOk ? null : (!metaId.ok ? 'dataset identity ' + metaId.reason : (!gates.meta_pixel ? 'marketing.measurement.meta_pixel_enabled is OFF' : 'no fresh real-browser evidence (run meta-browser-check + verify)')),
    { gate: gates.meta_pixel, identity: metaId.ok ? 'verified' : metaId.reason, browser_evidence_at: (ev.browser && ev.browser.at) || null, consent_denied_requests: ev.browser && ev.browser.denied ? ev.browser.denied.requests : null }));
  // 2 meta_capi
  const capiDecision = meta.decide({ cfg: { enabled: gates.meta_capi, datasetId: await cfg(r, 'marketing.measurement.meta_dataset_id'), identity: await cfg(r, 'marketing.measurement.meta_dataset_identity') }, tokenPresent: meta.tokenPresent(), advertisingConsent: true });
  // 2 meta_capi — dispatch decision READY + a Meta-acknowledged TEST event carrying the browser-shared event id
  const capiOk = capiDecision.status === 'ready' && fresh(ev.capi, 30) && fresh(ev.dedup, 30);
  items.push(item('meta_capi', has('src/services/measurement/metaCapiService.js') ? (capiOk ? 'VERIFIED' : 'PARTIAL') : 'MISSING',
    ['src/services/measurement/metaCapiService.js (event builder, event_id = the browser-shared meta_event_id else the conversion id, consent + identity gated)', 'marketing_conversion_events.provider_dispatch records the decision + Meta receipt per event'],
    capiOk ? null : (capiDecision.status !== 'ready' ? capiDecision.status + ' — ' + capiDecision.reason : 'no fresh acknowledged test event (run verify)'),
    { decision: capiDecision.status, credential_present: meta.tokenPresent(), events_received: ev.capi ? ev.capi.events_received : null, dedup_id_matches: ev.dedup ? !!ev.dedup.ok : null, evidence_at: (ev.capi && ev.capi.at) || null }));
  // 3 meta_click_id
  const fbCapture = tracker.includes("'fbclid'") && analyticsRoute.includes('/click-id');
  // 3 meta_click_id — fbclid captured → _fbc sent (proved by the verify test event) + _fbp available (Pixel verified)
  const clickOk = fbCapture && pixelOk && fresh(ev.click_id, 30);
  items.push(item('meta_click_id', !fbCapture ? 'MISSING' : (clickOk ? 'VERIFIED' : 'PARTIAL'),
    ['behavior-tracker.js captures fbclid → POST /api/analytics/click-id → marketing_click_ids (180-day retention)', 'conversions API sends _fbc (cookie, else derived from the captured fbclid) and _fbp (Pixel cookie)'],
    clickOk ? null : (!pixelOk ? '_fbp exists only once the Pixel is verified' : 'no fresh evidence that a captured fbclid reached the conversions API as _fbc'),
    { fbclid_rows: ((live.click_ids || []).find((x) => x.click_type === 'fbclid') || {}).n || 0, fbc_evidence_at: (ev.click_id && ev.click_id.at) || null }));
  // 4 google_ads_conversion
  const gDecision = google.decide({ cfg: { enabled: gates.google_conversions, customerId: await cfg(r, 'marketing.measurement.google_ads_customer_id'), identity: await cfg(r, 'marketing.measurement.google_ads_customer_identity'), actions: (await cfg(r, 'marketing.measurement.google_conversion_actions')) || {} }, conversionKey: 'buyer_registered', click: { click_type: 'gclid' }, advertisingConsent: true });
  items.push(item('google_ads_conversion', has('src/services/measurement/googleConversionsService.js') ? (gDecision.status === 'ready' ? 'VERIFIED' : 'PARTIAL') : 'MISSING',
    ['src/lib/conversionDefinitions.js google_action per key', 'src/services/measurement/googleConversionsService.js (click conversion builder, order_id dedup, consent + identity gated)'],
    gDecision.status === 'ready' ? null : 'provider activation: ' + gDecision.status + ' — Owner connects the Advantage.Bid Google Ads account and maps conversion actions', { decision: gDecision.status, identity: googleId.ok ? 'verified' : googleId.reason }));
  // 5 google_click_ids
  const gCapture = ['gclid', 'gbraid', 'wbraid'].every((t) => tracker.includes("'" + t + "'"));
  items.push(item('google_click_ids', gCapture && (await tableExists(r, 'marketing_click_ids')) ? 'VERIFIED' : 'MISSING',
    ['behavior-tracker.js captures gclid/gbraid/wbraid on landing → marketing_click_ids', 'clickIdService.purgeExpired default 180 days (≥ 90-day requirement)', 'linked to the user on login/registration (clickIdService.linkToUser)'],
    null, { rows: live.click_ids }));
  // 6 first_party_attribution
  const fpa = (await tableExists(r, 'marketing_attribution_touches')) && tracker.includes('/api/analytics/touch') && analyticsRoute.includes("'/touch'");
  items.push(item('first_party_attribution', fpa ? 'VERIFIED' : 'MISSING',
    ['POST /api/analytics/touch → attributionService.recordTouch → marketing_attribution_touches (landing URL, referrer, channel, UTM, click type + hash, consent, timestamp)', 'marketing_attribution_profiles keeps first / last / last-paid touch'],
    fpa ? null : 'touch capture not wired', { touches_30d: live.touches_30d, campaign_touches_30d: live.campaign_touches_30d }));
  // 7 utm_capture
  const utm = fpa && has('src/routes/auth.js', "emit('buyer_registered'") && has('public/login.html', 'visitor_id: (function');
  items.push(item('utm_capture', utm ? 'VERIFIED' : (fpa ? 'PARTIAL' : 'MISSING'),
    ['utm_source/medium/campaign/content/term persisted per touch', 'registration carries visitor_id → buyer_registered conversion snapshot; /api/analytics/identify stitches the visitor to the user'],
    utm ? null : 'registration does not carry the visitor', {}));
  // 8 behavioral_events
  const emitted = Object.entries(EMITTERS).map(([k, f]) => [k, has(f, "emit('" + k + "'")]);
  const missingEmit = emitted.filter(([, ok]) => !ok).map(([k]) => k);
  const analyticsKinds = ['page_view', 'search', 'lot_view'];
  items.push(item('behavioral_events', missingEmit.length === 0 ? 'VERIFIED' : 'PARTIAL',
    ['src/lib/conversionDefinitions.js (' + defs.KEYS.length + ' keys)', 'server emitters: ' + emitted.filter(([, ok]) => ok).map(([k]) => k + '→' + EMITTERS[k]).join(', '), 'page_view / search / lot_view via analytics_events (page_intent registry)'],
    missingEmit.length ? 'not emitted: ' + missingEmit.join(', ') : null, { required: REQUIRED_EVENTS, analytics_backed: analyticsKinds, conversions_by_key: live.conversions_by_key, page_views_7d: live.page_views_7d }));
  // 9 identity_stitching
  const stitch = analyticsRoute.includes('attribution.stitch') && has('public/login.html', '/api/analytics/identify');
  items.push(item('identity_stitching', stitch ? 'VERIFIED' : 'MISSING',
    ['login.html → POST /api/analytics/identify (server-derived user id) → behavioralIdentity.link + clickIds.linkToUser + attribution.stitch (90-day look-back)'], stitch ? null : 'stitch not wired', { stitched_profiles: live.stitched_profiles }));
  // 10 anon_to_known
  const policy = has('docs/marketing/measurement/anonymous-to-known-attribution-policy.md');
  items.push(item('anon_to_known', policy && stitch ? 'VERIFIED' : (policy || stitch ? 'PARTIAL' : 'MISSING'),
    ['docs/marketing/measurement/anonymous-to-known-attribution-policy.md', 'attributionService.stitch (explicit linkage only, 90-day look-back)'], policy ? null : 'policy document missing', {}));
  // 11 consent
  const consentOk = (await tableExists(r, 'consent_records')) && has('public/widgets/shared/consent-banner.js') && (!loader || loader.includes('advertising'));
  items.push(item('consent', consentOk ? 'VERIFIED' : 'PARTIAL',
    ['consent-banner.js publishes window.__ADV_CONSENT; consent_records is the append-only history', 'pixel loader requires advertising consent; CAPI / Google upload decide() require advertising consent', 'conversion ledger stamps advertising consent per event'],
    consentOk ? null : 'consent gating incomplete', { consent_records: live.consent_records, no_consent_refusal_evidence: ev.consent ? { ok: ev.consent.ok, at: ev.consent.at } : null, browser_denied_requests: ev.browser && ev.browser.denied ? ev.browser.denied.requests : null }));
  // 12 suppression
  items.push(item('suppression', has('src/services/audienceEligibilityService.js') && has('src/services/audienceMembershipService.js') ? 'PARTIAL' : 'MISSING',
    ['audienceEligibilityService (suppression / bounce / permission gates)', 'audienceMembershipService exits converted members from acquisition audiences'],
    'no provider (hashed) audience upload exists yet — destinations are OFF; uploads must be built on the eligibility gates before any retargeting', {}));
  // 13 retargeting_audiences
  items.push(item('retargeting_audiences', (await tableExists(r, 'marketing_audience_members')) ? 'PARTIAL' : 'MISSING',
    ['first-party audiences (marketing_audience_members; platformFactAudienceService)', 'Pixel website audiences become available to Meta once the Pixel is verified (consented visitors only)'],
    'provider audience export intentionally OFF: no first-party list is uploaded to Meta until the Owner approves it (marketing_audience_destinations disabled)' + (adAcctId.ok ? '' : '; ad account not connected'),
    { active_members: live.audience_members_active, pixel_audiences_possible: pixelOk, custom_audience_terms_accepted: (await cfg(r, 'marketing.measurement.meta_ad_account_identity') || {}).custom_audience_tos_accepted || false }));
  // 14 conversion_definitions
  items.push(item('conversion_definitions', defs.KEYS.length >= 15 && ['buyer_registered', 'seller_inquiry', 'auction_published', 'purchase'].every((k) => defs.get(k) && defs.get(k).meta_event && defs.get(k).google_action) ? 'VERIFIED' : 'PARTIAL',
    ['src/lib/conversionDefinitions.js — one definition shared by the first-party ledger, Meta and Google'], null, { keys: defs.KEYS.length, success_signals: defs.SUCCESS_SIGNALS }));
  // 15 cost_ingestion
  // 15 cost_ingestion — VERIFIED when the READ-ONLY Meta Insights pull is connected (Graph-verified Advantage.Bid ad account,
  // read gate ON) and a pull succeeded in the last 3 days. Google Ads is not connected: its own items stay PARTIAL and the
  // Google channel cannot activate (minimum_for_google).
  const costOk = gates.meta_cost_ingestion && adAcctId.ok && fresh(ev.cost, 3);
  items.push(item('cost_ingestion', has('src/services/measurement/paidCostIngestionService.js') ? (costOk ? 'VERIFIED' : 'PARTIAL') : 'MISSING',
    ['paidCostIngestionService.pullMeta — daily READ-ONLY Meta Ads Insights → marketing_paid_cost_facts (+ mirror to marketing_performance_facts, purchase_kind paid_growth)', 'marketingRefreshWorker.costPass (daily, gated on marketing.measurement.meta_cost_ingestion_enabled)'],
    costOk ? 'Meta connected; Google Ads cost not connected (Google channel stays unavailable)' : (!adAcctId.ok ? 'Meta ad account identity ' + adAcctId.reason : (!gates.meta_cost_ingestion ? 'marketing.measurement.meta_cost_ingestion_enabled is OFF' : 'no successful Meta cost pull in the last 3 days')),
    { cost_fact_rows: live.cost_fact_rows, meta_read_gate: gates.meta_cost_ingestion, ad_account_identity: adAcctId.ok ? 'verified' : adAcctId.reason, last_pull: ev.cost ? { at: ev.cost.at, ok: ev.cost.ok, rows: ev.cost.rows, spend_cents: ev.cost.spend_cents } : null, meta_ads_gate: gates.meta_ads, google_ads_gate: gates.google_ads }));
  // 16 provider_reconciliation
  items.push(item('provider_reconciliation', has('src/services/measurement/providerReconciliationService.js') ? 'VERIFIED' : 'MISSING',
    ['providerReconciliationService.reconcile → marketing_provider_reconciliations (both numbers recorded; never averaged)'], null, { reconciliations: live.reconciliations }));
  // 17 marketplace_outcome_attribution
  items.push(item('marketplace_outcome_attribution', has('src/services/measurement/outcomeAttributionService.js') ? 'VERIFIED' : 'MISSING',
    ['outcomeAttributionService.campaignFacts — campaign → session → user → action → outcome with MEASURED / INFLUENCED / ATTRIBUTION_UNAVAILABLE; DELIVERED from cost facts'], null, {}));
  // 18 director_facts
  items.push(item('director_facts', has('src/services/paidGrowth/paidGrowthDirector.js') && has('src/services/paidGrowth/paidGrowthReport.js') ? 'VERIFIED' : 'MISSING',
    ['paidGrowthDirector (signal states, checkpoints, bounded actions, shadow mode)', 'paidGrowthReport (weekly / state-change / monthly; package economics structurally excluded)'], null, {}));

  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  const rule = (keys) => { const not = keys.filter((k) => byKey[k].status !== 'VERIFIED'); return { ready: not.length === 0, not_verified: not.map((k) => k + ':' + byKey[k].status) }; };
  const rules = Object.fromEntries(Object.entries(RULES).map(([k, keys]) => [k, rule(keys)]));
  const counts = items.reduce((a, i) => { a[i.status] = (a[i.status] || 0) + 1; return a; }, {});
  return { evaluated_at: new Date().toISOString(), items, counts, rules, gates, measurement_ready: rules.minimum_for_any_paid_activation.ready };
}

module.exports = { evaluate, RULES, REQUIRED_EVENTS, EMITTERS };
