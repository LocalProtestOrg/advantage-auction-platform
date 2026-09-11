#!/usr/bin/env node
/* meta-measurement-connect.js — connect + verify the Advantage.Bid Meta MEASUREMENT assets (Pixel/dataset, Conversions API,
   read-only cost ingestion). PRODUCTION-guarded. Never prints, logs or stores a credential: tokens are read from the Railway
   environment (META_CAPI_ACCESS_TOKEN, META_ADS_READ_TOKEN) and only their presence is reported.

   It never creates, edits, starts or pays for any Meta asset, campaign or ad. Paid gates (marketing.destinations.*) and the
   Paid Growth Director mode are asserted untouched (OFF / shadow) on every run.

   Usage (railway run --environment production -- node scripts/meta-measurement-connect.js <cmd> [flags]):
     discover                                   list the ad accounts / datasets the tokens can see (ids + names only)
     connect --dataset=<id> --ad-account=<act_id> Graph-verify both assets are Advantage.Bid's (never Lewis & Maese) and record
                                                them with their identity records. Does not enable anything.
     read-probe --ad-account=<act_id>            READ-ONLY: permissions (ads_read yes, ads_management no), campaign / ad set /
                                                ad / creative structure and Insights metric coverage. Writes nothing but an
                                                aggregated evidence record (no spend figures, no names).
     cost-pull [--since=YYYY-MM-DD]             READ-ONLY Insights pull for the canonical ad account (default last 7 days).
     enable-measurement                         turn ON the three MEASUREMENT gates (pixel, conversions API, read-only cost
                                                ingestion) — refuses unless identities are verified and credentials present.
     verify --test-event-code=<CODE> [--browser-evidence=<file>]
                                                labelled end-to-end checks: Conversions API TEST event (dedup id + consent),
                                                no-consent refusal, fbclid → fbc, dataset status, read-only cost pull. Test
                                                ledger rows are removed afterwards; the receipts are kept as evidence.
*/
const fs = require('fs');
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db'));
const guard = require(path.join(__dirname, '..', 'src', 'services', 'measurement', 'assetIdentityGuard'));

const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const V = process.env.META_GRAPH_VERSION || 'v21.0';
const PAID_OFF = ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled', 'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled', 'marketing.social.reply_draft_enabled'];
const MEASUREMENT_GATES = ['marketing.measurement.meta_pixel_enabled', 'marketing.measurement.meta_capi_enabled', 'marketing.measurement.meta_cost_ingestion_enabled'];
const SECRETS = () => [process.env.META_CAPI_ACCESS_TOKEN, process.env.META_ADS_READ_TOKEN, process.env.META_SYSTEM_USER_TOKEN, process.env.META_APP_SECRET].filter((x) => x && x.length > 8);
const scrub = (s) => { let o = String(s); for (const t of SECRETS()) o = o.split(t).join('[credential]'); return o; };
const arg = (name) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : null; };
const present = (k) => Boolean(process.env[k] && String(process.env[k]).length > 20);

function assertProd() {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) throw new Error('REFUSE: DATABASE_URL not set');
  if (raw.includes(STG_EP)) throw new Error('REFUSE: staging endpoint');
  if (!raw.includes(PROD_EP)) throw new Error('REFUSE: not the production endpoint');
}
async function cfg(k) { const r = await db.query(`SELECT value FROM platform_config WHERE key=$1`, [k]); return r.rows[0] ? r.rows[0].value : null; }
async function setCfg(k, v) {
  const r = await db.query(`UPDATE platform_config SET value=$2::jsonb, updated_at=now() WHERE key=$1`, [k, JSON.stringify(v)]);
  if (!r.rowCount) throw new Error('config key missing (apply migration 150 first): ' + k);
}
async function mergeEvidence(patch) { await db.query(`UPDATE platform_config SET value = COALESCE(value,'{}'::jsonb) || $1::jsonb, updated_at=now() WHERE key='marketing.measurement.meta_verification'`, [JSON.stringify(patch)]); }
async function assertPaidOff() {
  const on = (await db.query(`SELECT key FROM platform_config WHERE key = ANY($1) AND (value='true'::jsonb OR value='"true"'::jsonb)`, [PAID_OFF])).rows.map((x) => x.key);
  const mode = await cfg('marketing.paid_growth.mode');
  if (on.length || mode !== 'shadow') throw new Error('REFUSE: a paid/publish gate is ON or the Director is not in shadow mode: ' + JSON.stringify({ on, mode }));
  return { paid_gates_on: on, director_mode: mode };
}

async function graph(p, tokenKey) {
  const token = process.env[tokenKey];
  if (!token) return { error: { message: tokenKey + ' not set' } };
  try {
    const res = await fetch('https://graph.facebook.com/' + V + p, { headers: { Authorization: 'Bearer ' + token } });
    const j = await res.json();
    return j.error ? { error: { code: j.error.code, type: j.error.type, message: scrub(j.error.message).slice(0, 200) } } : j;
  } catch (e) { return { error: { message: scrub(e.message).slice(0, 200) } }; }
}
const readTokenKey = () => (present('META_ADS_READ_TOKEN') ? 'META_ADS_READ_TOKEN' : 'META_CAPI_ACCESS_TOKEN');

async function discover() {
  const out = { credentials: { META_CAPI_ACCESS_TOKEN: present('META_CAPI_ACCESS_TOKEN'), META_ADS_READ_TOKEN: present('META_ADS_READ_TOKEN') } };
  const k = readTokenKey();
  out.me = await graph('/me?fields=id,name', k);
  out.permissions = await graph('/me/permissions', k);
  out.ad_accounts = await graph('/me/adaccounts?fields=id,name,account_status,currency,business{id,name}&limit=50', k);
  out.candidates = [];
  for (const a of ((out.ad_accounts && out.ad_accounts.data) || [])) {
    const px = await graph('/' + a.id + '/adspixels?fields=id,name,owner_business{id,name},last_fired_time&limit=50', k);
    const idCheck = guard.check('meta_ad_account', a.id, { id: a.id, name: a.name, owner_business: a.business && a.business.name, verified_at: 'discover' });
    out.candidates.push({ ad_account: { id: a.id, name: a.name, business: a.business || null, status: a.account_status, identity: idCheck.ok ? 'advantage_bid' : idCheck.reason },
      datasets: ((px && px.data) || []).map((p) => ({ id: p.id, name: p.name, owner_business: p.owner_business || null, last_fired_time: p.last_fired_time || null,
        identity: guard.check('meta_dataset', p.id, { id: p.id, name: p.name, owner_business: p.owner_business && p.owner_business.name, verified_at: 'discover' }).ok ? 'advantage_bid' : 'refused' })),
      datasets_error: px && px.error ? px.error.message : null });
  }
  return out;
}

async function connect() {
  const datasetId = String(arg('dataset') || '').trim(); const act = String(arg('ad-account') || '').trim();
  if (!/^\d{8,20}$/.test(datasetId)) throw new Error('--dataset=<numeric dataset id> is required');
  const actId = act ? (act.startsWith('act_') ? act : 'act_' + act) : null;
  if (actId && !/^act_\d{5,20}$/.test(actId)) throw new Error('--ad-account=<act_ numeric id> is malformed');
  if (actId && guard.isExcluded(actId, (await cfg('marketing.measurement.meta_ad_account_excluded')) || [])) throw new Error('REFUSE: ' + actId + ' is on the Owner exclusion list (never connected, pulled or ingested)');
  const k = readTokenKey();
  const ds = await graph('/' + datasetId + '?fields=id,name,owner_business{id,name},last_fired_time,is_unavailable,creation_time', k);
  if (ds.error) throw new Error('dataset lookup failed: ' + ds.error.message);
  const now = new Date().toISOString();
  const dsIdentity = { id: String(ds.id), name: ds.name || null, owner_business: (ds.owner_business && ds.owner_business.name) || null, owner_business_id: (ds.owner_business && ds.owner_business.id) || null,
    verified_at: now, verified_by: 'graph_api:' + k };
  const dsCheck = guard.check('meta_dataset', datasetId, dsIdentity);
  const out = { dataset: { id: dsIdentity.id, name: dsIdentity.name, owner_business: dsIdentity.owner_business, last_fired_time: ds.last_fired_time || null, is_unavailable: ds.is_unavailable || false, identity: dsCheck.ok ? 'VERIFIED' : dsCheck.reason } };
  let acIdentity = null, acCheck = { ok: true };
  if (actId) {
    const ac = await graph('/' + actId + '?fields=id,name,account_status,disable_reason,currency,user_tos_accepted', 'META_ADS_READ_TOKEN');
    if (ac.error) throw new Error('ad account lookup failed (needs META_ADS_READ_TOKEN with ads_read): ' + ac.error.message);
    // The owning business is only readable with business_management (deliberately NOT granted); try, never require.
    const acBiz = await graph('/' + actId + '?fields=business{id,name}', 'META_ADS_READ_TOKEN');
    acIdentity = { id: ac.id, name: ac.name || null, owner_business: (acBiz.business && acBiz.business.name) || null, owner_business_id: (acBiz.business && acBiz.business.id) || null, currency: ac.currency || null,
      account_status: ac.account_status, disable_reason: ac.disable_reason, owner_business_readable: !acBiz.error,
      owner_confirmed: process.argv.includes('--owner-confirmed') ? { at: now, statement: 'Owner confirmed this is the dedicated Advantage.Bid ad account' } : null,
      custom_audience_tos_accepted: !!(ac.user_tos_accepted && ac.user_tos_accepted.custom_audience_tos), verified_at: now, verified_by: 'graph_api:META_ADS_READ_TOKEN' };
    acCheck = guard.check('meta_ad_account', actId, acIdentity);
    out.ad_account = { id: acIdentity.id, name: acIdentity.name, owner_business: acIdentity.owner_business, currency: acIdentity.currency, status: acIdentity.account_status, custom_audience_tos_accepted: acIdentity.custom_audience_tos_accepted, identity: acCheck.ok ? 'VERIFIED' : acCheck.reason };
    if (dsIdentity.owner_business_id && acIdentity.owner_business_id && dsIdentity.owner_business_id !== acIdentity.owner_business_id) out.warning = 'dataset and ad account belong to different businesses';
  }
  // Each asset is recorded ONLY when its own identity is proven Advantage.Bid's; a refused asset is never recorded.
  out.recorded = {};
  if (dsCheck.ok) { await setCfg('marketing.measurement.meta_dataset_id', datasetId); await setCfg('marketing.measurement.meta_dataset_identity', dsIdentity); out.recorded.dataset = true; }
  else out.recorded.dataset = 'REFUSED: ' + dsCheck.reason;
  if (actId) {
    if (acCheck.ok) { await setCfg('marketing.measurement.meta_ad_account_id', actId); await setCfg('marketing.measurement.meta_ad_account_identity', acIdentity); out.recorded.ad_account = true; }
    else out.recorded.ad_account = 'REFUSED: ' + acCheck.reason + ' — ' + acCheck.detail;
  }
  return out;
}

async function readProbe() {
  const act0 = String(arg('ad-account') || '').trim();
  const act = act0.startsWith('act_') ? act0 : 'act_' + act0;
  if (!/^act_\d{5,20}$/.test(act)) throw new Error('--ad-account=<act_ numeric id> is required');
  const K = 'META_ADS_READ_TOKEN';
  const perms = await graph('/me/permissions', K);
  const granted = ((perms && perms.data) || []).filter((x) => x.status === 'granted').map((x) => x.permission);
  const out = { account: act, permissions: { ads_read: granted.includes('ads_read'), ads_management: granted.includes('ads_management'), business_management: granted.includes('business_management') } };
  const acct = await graph('/' + act + '?fields=id,account_status,disable_reason,currency', K);
  out.account_read = acct.error ? { ok: false, error: acct.error.message } : { ok: true, account_status: acct.account_status, disable_reason: acct.disable_reason, currency: acct.currency };
  const count = async (edge, fields) => { const j = await graph('/' + act + '/' + edge + '?fields=' + fields + '&limit=100', K); return j.error ? { ok: false, error: j.error.message } : { ok: true, returned: (j.data || []).length, more: !!(j.paging && j.paging.next), sample_fields: Object.keys((j.data || [])[0] || {}) }; };
  out.structure = { campaigns: await count('campaigns', 'id,name,objective,effective_status'), adsets: await count('adsets', 'id,name,campaign_id,effective_status'), ads: await count('ads', 'id,name,adset_id,campaign_id,creative{id},effective_status') };
  const cost = require(path.join(__dirname, '..', 'src', 'services', 'measurement', 'paidCostIngestionService'));
  const until = new Date(Date.now() - 86400000).toISOString().slice(0, 10); const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const ins = await graph('/' + act + '/insights?level=ad&time_increment=1&limit=500&fields=' + cost.META_INSIGHT_FIELDS.join(',') + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until })), K);
  const life = await graph('/' + act + '/insights?level=account&date_preset=maximum&fields=' + cost.META_INSIGHT_FIELDS.filter((f) => !/^(campaign|adset|ad)_/.test(f)).join(','), K);
  let rows = (ins && ins.data) || [];
  let grainWindow = 'last_30_days';
  if (!rows.length && !ins.error) {
    // No recent delivery: prove the ad-level grain on the account's lifetime rows instead (read in memory, never stored).
    const lifeAds = await graph('/' + act + '/insights?level=ad&date_preset=maximum&limit=100&fields=' + cost.META_INSIGHT_FIELDS.join(','), K);
    if (!lifeAds.error && (lifeAds.data || []).length) { rows = lifeAds.data; grainWindow = 'lifetime (no delivery in the last 30 days)'; }
  }
  const creatives = rows.length ? await cost.metaCreativeMap(act, process.env[K], V) : {};
  const mapped = rows.map((x) => cost.metaInsightToRow(x, act, creatives));
  const lifeRow = ((life && life.data) || [])[0] || {};
  const coverage = {};
  for (const f of cost.META_INSIGHT_FIELDS) coverage[f] = rows.length ? rows.some((x) => x[f] !== undefined) : (lifeRow[f] !== undefined ? true : 'no rows to test');
  const recent = ((ins && ins.data) || []).length;
  out.insights = { window: { since, until }, ok: !ins.error, error: ins.error ? ins.error.message : null, rows_last_30d: recent, grain_rows_tested: rows.length, grain_window: grainWindow, lifetime_account_row: !life.error && !!lifeRow.date_start,
    lifetime_fields_returned: Object.keys(lifeRow).filter((k) => !/^date_/.test(k)), coverage,
    director_grain: mapped.length ? { campaign_ids: new Set(mapped.map((m) => m.campaign_id)).size, adset_ids: new Set(mapped.map((m) => m.adset_id)).size, ad_ids: new Set(mapped.map((m) => m.ad_id)).size,
      creative_ids: new Set(mapped.map((m) => m.creative_id).filter(Boolean)).size,
      mapped_fields_present: ['campaign_name', 'adset_name', 'ad_name', 'creative_id', 'spend', 'impressions', 'reach', 'clicks', 'link_clicks'].filter((f) => mapped.some((m) => m[f] !== null && m[f] !== undefined && m[f] !== '')),
      provider_ratios_present: ['ctr', 'cpc', 'cpm'].filter((f) => mapped.some((m) => m.provider_metrics[f] != null)),
      action_types_seen: [...new Set(mapped.flatMap((m) => Object.keys(m.provider_metrics.actions || {})))].length,
      derived_from_sums_example: cost.derivedMetrics(mapped.reduce((a, m) => ({ spend_cents: a.spend_cents + Math.round(m.spend * 100), impressions: a.impressions + m.impressions, clicks: a.clicks + m.clicks, link_clicks: a.link_clicks + (m.link_clicks || 0) }), { spend_cents: 0, impressions: 0, clicks: 0, link_clicks: 0 })) }
      : 'no delivery (zero rows is acceptable)' };
  out.writes = 'none (read-only probe; nothing ingested)';
  await mergeEvidence({ read_probe: { at: new Date().toISOString(), ok: out.insights.ok && out.account_read.ok && out.permissions.ads_read && !out.permissions.ads_management, account: act, ads_management_granted: out.permissions.ads_management,
    rows_last_30d: recent, grain_rows_tested: rows.length, lifetime_fields_returned: out.insights.lifetime_fields_returned } });
  return out;
}

/** READ-ONLY cost pull for the canonical, identity-verified, non-excluded Advantage.Bid ad account. Records evidence. */
async function costPull() {
  const paid = await assertPaidOff();
  const cost = require(path.join(__dirname, '..', 'src', 'services', 'measurement', 'paidCostIngestionService'));
  const since = arg('since') || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const out = await cost.pull('meta_ads', { since }, db);
  return { ...out, ...(await assertPaidOff()), before: paid };
}

async function enableMeasurement() {
  const paid = await assertPaidOff();
  const ds = guard.check('meta_dataset', await cfg('marketing.measurement.meta_dataset_id'), await cfg('marketing.measurement.meta_dataset_identity'));
  if (!ds.ok) throw new Error('REFUSE: dataset identity not verified (' + ds.reason + ')');
  if (!present('META_CAPI_ACCESS_TOKEN')) throw new Error('REFUSE: META_CAPI_ACCESS_TOKEN not present');
  await setCfg('marketing.measurement.meta_pixel_enabled', true);
  await setCfg('marketing.measurement.meta_capi_enabled', true);
  const ac = guard.check('meta_ad_account', await cfg('marketing.measurement.meta_ad_account_id'), await cfg('marketing.measurement.meta_ad_account_identity'));
  const costOn = ac.ok && present('META_ADS_READ_TOKEN');
  if (costOn) await setCfg('marketing.measurement.meta_cost_ingestion_enabled', true);
  return { enabled: MEASUREMENT_GATES.filter((g, i) => i < 2 || costOn), cost_ingestion: costOn ? 'ON (read-only)' : 'left OFF (' + (ac.ok ? 'META_ADS_READ_TOKEN absent' : ac.reason) + ')', ...(await assertPaidOff()), before: paid };
}

async function verify() {
  const paid = await assertPaidOff();
  const code = arg('test-event-code');
  if (!code || !/^[A-Za-z0-9]{4,32}$/.test(code)) throw new Error('--test-event-code=<code from Events Manager → Test events> is required (events sent with it are TEST events, excluded from reporting)');
  const conv = require(path.join(__dirname, '..', 'src', 'services', 'conversionService'));
  const meta = require(path.join(__dirname, '..', 'src', 'services', 'measurement', 'metaCapiService'));
  const cfgMeta = await meta.loadConfig();
  const ts = Date.now();
  const V1 = 'meta-verify-' + ts; const V2 = 'meta-verify-noconsent-' + ts;
  const EV = 'ev-verify-' + ts.toString(36);
  const FBCLID = 'VERIFY' + ts.toString(36).toUpperCase();
  const out = { labelled_visitors: [V1, V2], event_id: EV };
  try {
    // consent granted for V1 only (labelled rows, removed afterwards); a captured fbclid for V1 proves fbclid → _fbc
    await db.query(`INSERT INTO consent_records (scope_type, scope_id, category, state, source, policy_version, reason) VALUES ('visitor',$1,'advertising','granted','api','v1','Meta measurement verification (labelled test visitor)')`, [V1]);
    await db.query(`INSERT INTO marketing_click_ids (scope_type, scope_id, click_type, click_value, source) VALUES ('visitor',$1,'fbclid',$2,'measurement-verification')`, [V1, FBCLID]);
    const ctx = { clientIp: '203.0.113.10', userAgent: 'AdvantageBidMeasurementVerification/1.0', sourceUrl: 'https://bid.advantage.bid/assisted-service.html?utm_source=verification&utm_campaign=meta_measurement_check' };
    // 1. consented conversion → Conversions API TEST event with the browser-shared event id
    const r1 = await conv.record('assisted_service_inquiry', { visitorId: V1, subjectType: 'measurement_verification', subjectId: V1, eventId: EV, meta: ctx, testEventCode: code, idempotencyKey: 'verify:' + V1 });
    let row1 = null;
    for (let i = 0; i < 30; i += 1) {
      row1 = (await db.query(`SELECT id, provider_event_id, provider_dispatch FROM marketing_conversion_events WHERE idempotency_key=$1`, ['verify:' + V1])).rows[0];
      const st = row1 && row1.provider_dispatch && row1.provider_dispatch.meta_capi && row1.provider_dispatch.meta_capi.status;
      if (st && st !== 'ready') break;
      await new Promise((res) => setTimeout(res, 500));
    }
    const d1 = (row1 && row1.provider_dispatch && row1.provider_dispatch.meta_capi) || {};
    out.capi = { ok: d1.status === 'sent' && Number(d1.events_received) >= 1 && d1.event_id === EV && !!d1.test, status: d1.status || (r1 && r1.dispatch && r1.dispatch.meta_capi) || null,
      events_received: d1.events_received || 0, fbtrace_id: d1.fbtrace_id || null, test_event: !!d1.test, event_id_sent: d1.event_id || null, dedup_id_matches_browser: d1.event_id === EV,
      matched_on: d1.matched_on || [], error: d1.error || null, at: new Date().toISOString() };
    out.click_id = { ok: (d1.matched_on || []).includes('fbc'), fbc_from_captured_fbclid: (d1.matched_on || []).includes('fbc'), at: out.capi.at };
    // 2. no consent → nothing sent
    await conv.record('assisted_service_inquiry', { visitorId: V2, subjectType: 'measurement_verification', subjectId: V2, eventId: EV + 'n', meta: ctx, testEventCode: code, idempotencyKey: 'verify:' + V2 });
    const row2 = (await db.query(`SELECT provider_dispatch FROM marketing_conversion_events WHERE idempotency_key=$1`, ['verify:' + V2])).rows[0];
    const d2 = (row2 && row2.provider_dispatch && row2.provider_dispatch.meta_capi) || {};
    out.consent = { ok: d2.status === 'no_consent', no_consent_status: d2.status || null, at: new Date().toISOString() };
  } finally {
    // remove the labelled test rows (receipts are kept in the evidence record)
    await db.query(`DELETE FROM marketing_conversion_events WHERE idempotency_key = ANY($1)`, [['verify:' + V1, 'verify:' + V2]]);
    await db.query(`DELETE FROM consent_records WHERE scope_type='visitor' AND scope_id = ANY($1)`, [[V1, V2]]);
    await db.query(`DELETE FROM marketing_click_ids WHERE scope_id = ANY($1)`, [[V1, V2]]);
    await db.query(`DELETE FROM marketing_attribution_profiles WHERE visitor_id = ANY($1)`, [[V1, V2]]);
    out.cleanup = 'labelled verification rows removed';
  }
  // 3. dataset status (Graph)
  const ds = await graph('/' + cfgMeta.datasetId + '?fields=id,name,last_fired_time,is_unavailable', readTokenKey());
  out.dataset = ds.error ? { ok: false, error: ds.error.message } : { ok: !ds.is_unavailable, id: ds.id, name: ds.name, last_fired_time: ds.last_fired_time || null };
  // 4. browser evidence (from scripts/meta-browser-check.js, run with a real browser)
  const bf = arg('browser-evidence');
  if (bf && fs.existsSync(bf)) {
    const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
    out.browser = { ok: !!(b.consented && b.consented.pageview && b.consented.dataset_matches && b.denied && b.denied.requests === 0 && b.dedup && b.dedup.event_id_matches), ...b };
  }
  // 5. read-only cost pull (last 7 days)
  const cost = require(path.join(__dirname, '..', 'src', 'services', 'measurement', 'paidCostIngestionService'));
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const cp = await cost.pull('meta_ads', { since }, db);
  out.cost = cp.pulled ? { ok: true, rows: cp.rows, spend_cents: cp.spend_cents, since: cp.since, until: cp.until, at: new Date().toISOString() } : { ok: false, reason: cp.reason, detail: cp.detail, at: new Date().toISOString() };
  out.dedup = { ok: !!(out.capi && out.capi.dedup_id_matches_browser) && (!out.browser || !!(out.browser.dedup && out.browser.dedup.event_id_matches)), rule: 'Pixel eventID = Conversions API event_id for the same conversion (meta_event_id)', at: new Date().toISOString() };
  const evidence = { capi: out.capi, consent: out.consent, click_id: out.click_id, dataset: out.dataset, dedup: out.dedup };
  if (out.browser) evidence.browser = out.browser;
  await mergeEvidence(evidence);
  out.paid = await assertPaidOff();
  out.before = paid;
  return out;
}

(async () => {
  assertProd();
  const cmd = process.argv[2];
  const run = { discover, connect, 'read-probe': readProbe, 'enable-measurement': enableMeasurement, 'cost-pull': costPull, verify }[cmd];
  if (!run) { console.error('usage: discover | connect --dataset= --ad-account= [--owner-confirmed] | read-probe --ad-account= | enable-measurement | cost-pull [--since=] | verify --test-event-code= [--browser-evidence=]'); process.exit(2); }
  const out = await run();
  console.log(cmd.toUpperCase() + ' ' + scrub(JSON.stringify(out, null, 1)));
  process.exit(0);
})().catch((e) => { console.error('ERR ' + scrub(e.message)); process.exit(1); });
