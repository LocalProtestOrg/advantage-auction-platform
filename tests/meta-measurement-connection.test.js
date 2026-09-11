'use strict';

/**
 * Meta measurement connection — request context for the Conversions API (never stored), browser/server deduplication
 * (the Pixel's eventID = the server event_id), TEST-event labelling, the READ-ONLY Meta cost puller (gated, identity-
 * checked, GET-only), campaign-key normalisation shared by cost and landing, Meta reconciliation by event name, the
 * connect script's safety rails, and readiness items that need fresh evidence (never configuration alone).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-meta';
const fs = require('fs');
const path = require('path');

const conv = require('../src/services/conversionService');
const meta = require('../src/services/measurement/metaCapiService');
const cost = require('../src/services/measurement/paidCostIngestionService');
const recon = require('../src/services/measurement/providerReconciliationService');
const attribution = require('../src/services/attributionService');
const guard = require('../src/services/measurement/assetIdentityGuard');
const readiness = require('../src/services/measurement/measurementReadinessService');
const ROOT = path.join(__dirname, '..');

const cfgDb = (map, extra = []) => fakeDb([[/FROM platform_config WHERE key=\$1/, (sql, params) => (map[params[0]] === undefined ? { rows: [], rowCount: 0 } : { rows: [{ value: map[params[0]] }], rowCount: 1 })], ...extra]);
function fakeDb(routes = []) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql: String(sql), params }); for (const [re, rows] of routes) if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : { rows, rowCount: rows.length }; return { rows: [], rowCount: 0 }; } };
}

describe('Conversions API request context + deduplication', () => {
  test('ctxFromReq reads IP / user agent / _fbp / _fbc / page and a well-formed browser event id; nothing else', () => {
    const c = conv.ctxFromReq({ headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1', 'user-agent': 'UA', cookie: 'x=1; _fbp=fb.1.1700000000000.42; _fbc=fb.1.1700000000000.CLICK', referer: 'https://bid.advantage.bid/login.html' }, body: { meta_event_id: 'ev-abc12345' } });
    expect(c).toEqual({ eventId: 'ev-abc12345', meta: { clientIp: '198.51.100.7', userAgent: 'UA', fbp: 'fb.1.1700000000000.42', fbc: 'fb.1.1700000000000.CLICK', sourceUrl: 'https://bid.advantage.bid/login.html' } });
    expect(conv.ctxFromReq({ headers: {}, body: { meta_event_id: 'bad id!' } }).eventId).toBeNull();
    expect(conv.ctxFromReq(null).eventId).toBeNull();
  });
  test('the server event_id is the browser-shared id when present, else the conversion id; malformed cookies are dropped', () => {
    const shared = meta.buildEvent({ id: 'c-1', provider_event_id: 'ev-shared1', conversion_key: 'buyer_registered', user_id: 'u' }, { fbp: 'fb.1.1700.99', fbc: 'garbage' });
    expect(shared.event_id).toBe('ev-shared1'); expect(shared.user_data.fbp).toBe('fb.1.1700.99'); expect(shared.user_data.fbc).toBeUndefined();
    expect(meta.buildEvent({ id: 'c-2', conversion_key: 'purchase' }, {}).event_id).toBe('c-2');
  });
  test('the ledger stores the browser event id and never stores the request context (IP / user agent / cookies)', async () => {
    const cfgSvc = require('../src/services/configService'); const orig = cfgSvc.get; cfgSvc.get = async () => null;
    try {
      const db = fakeDb([[/INSERT INTO marketing_conversion_events/, [{ id: 'c1', occurred_at: new Date().toISOString() }]]]);
      await conv.record('email_signup', { visitorId: 'v1', eventId: 'ev-abcdef12', meta: { clientIp: '198.51.100.7', userAgent: 'UA', fbp: 'fb.1.1.2' } }, db);
      const ins = db.calls.find((c) => /INSERT INTO marketing_conversion_events/.test(c.sql));
      expect(ins.params[12]).toBe('ev-abcdef12');
      expect(JSON.stringify(ins.params)).not.toMatch(/198\.51\.100\.7|fb\.1\.1\.2/);
    } finally { cfgSvc.get = orig; }
  });
  test('TEST events: a well-formed test_event_code is attached; send() still refuses while the gate is OFF', async () => {
    const spy = jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('no network'); });
    try {
      const out = await meta.send([{ event_name: 'Lead' }], { advertisingConsent: true, testEventCode: 'TEST123', cfg: { enabled: false } });
      expect(out.sent).toBe(false); expect(out.decision.status).toBe('gated_off'); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  test('when ready, send() posts the events with the test code and returns the receipt — never the credential', async () => {
    const prev = process.env.META_CAPI_ACCESS_TOKEN; process.env.META_CAPI_ACCESS_TOKEN = 'x'.repeat(40);
    const bodies = [];
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => { bodies.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ events_received: 1, fbtrace_id: 'TRACE' }) }; });
    try {
      const identity = { id: '123456789012345', name: 'Advantage.Bid', owner_business: 'Advantage.Bid', verified_at: 'x' };
      const out = await meta.send([{ event_name: 'Lead', event_id: 'ev-1' }], { advertisingConsent: true, testEventCode: 'TEST123', cfg: { enabled: true, datasetId: '123456789012345', identity } });
      expect(out).toMatchObject({ sent: true, events_received: 1, fbtrace_id: 'TRACE', test: true });
      expect(bodies[0].url).toMatch(/\/123456789012345\/events$/); expect(bodies[0].body.test_event_code).toBe('TEST123');
      expect(JSON.stringify(out)).not.toContain('x'.repeat(40));
    } finally { spy.mockRestore(); if (prev === undefined) delete process.env.META_CAPI_ACCESS_TOKEN; else process.env.META_CAPI_ACCESS_TOKEN = prev; }
  });
});

describe('browser forms share their event id with the server', () => {
  test.each([
    ['public/login.html', 'buyer_registered'],
    ['public/assisted-service.html', 'assisted_service_inquiry'],
    ['public/widgets/shared/subscribe-widget.js', 'email_signup'],
  ])('%s sends meta_event_id and tracks %s with the same id', (file, key) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(src).toMatch(/meta_event_id/);
    expect(src).toContain("track('" + key + "'");
  });
  test('the login page loads only the consent-gated measurement loader (no analytics tracker added)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/login.html'), 'utf8');
    expect(src).toContain('/widgets/shared/ad-measurement.js');
    expect(src).not.toContain('behavior-tracker.js');
  });
  test('route emitters pass the request context', () => {
    for (const f of ['src/routes/auth.js', 'src/routes/publicSubscribe.js', 'src/routes/watchlist.js', 'src/routes/auctions.js', 'src/routes/sellers.js', 'src/routes/publicAssistedService.js']) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8')).toContain('ctxFromReq(req)');
    }
  });
});

describe('READ-ONLY Meta cost ingestion', () => {
  test('insights rows map to cost facts; Meta action types fold to standard event names', () => {
    const row = cost.metaInsightToRow({ campaign_id: '9', campaign_name: 'Houston Sellers', adset_id: '8', ad_id: '7', spend: '25.50', impressions: '2000', clicks: '31', date_start: '2026-09-10',
      actions: [{ action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '2' }, { action_type: 'link_click', value: '31' }] }, 'act_1');
    expect(row).toMatchObject({ campaign_id: '9', date: '2026-09-10', spend: 25.5, impressions: 2000, clicks: 31, provider_conversions: { CompleteRegistration: 2 } });
    expect(cost.normalise('meta_ads', row).campaign_key).toBe('facebook:houston_sellers');
  });
  test('cost and landing share one campaign key (lower case, whitespace → _)', () => {
    expect(attribution.campaignKey({ utm: { utm_source: 'facebook', utm_campaign: 'Houston Sellers' } })).toBe(cost.campaignKeyFor('meta_ads', { campaign_name: 'Houston Sellers' }));
  });
  test('the read gate is separate from the paid-ads gate; pulls refuse without it, without a verified ad account, or without the read credential', async () => {
    expect(cost.PROVIDERS.meta_ads.gate).toBe('marketing.measurement.meta_cost_ingestion_enabled');
    const cfgSvc = require('../src/services/configService'); const orig = cfgSvc.get; cfgSvc.get = async () => false;
    try { expect((await cost.pull('meta_ads')).reason).toBe('GATED_OFF'); } finally { cfgSvc.get = orig; }
    const noId = await cost.pullMeta({}, cfgDb({ 'marketing.measurement.meta_ad_account_id': 'act_123' }));
    expect(noId.pulled).toBe(false); expect(noId.reason).toBe('IDENTITY_UNVERIFIED');
    const lm = await cost.pullMeta({}, cfgDb({ 'marketing.measurement.meta_ad_account_id': 'act_555', 'marketing.measurement.meta_ad_account_identity': { id: 'act_555', name: 'L&M Ads', owner_business: 'Lewis & Maese Antiques', verified_at: 'x' } }));
    expect(lm.reason).toBe('DENIED_CLIENT_ASSET');
    const prev = process.env.META_ADS_READ_TOKEN; delete process.env.META_ADS_READ_TOKEN;
    try {
      const ok = { id: 'act_123', name: 'Advantage.Bid Ads', owner_business: 'Advantage.Bid', verified_at: 'x' };
      const noTok = await cost.pullMeta({}, cfgDb({ 'marketing.measurement.meta_ad_account_id': 'act_123', 'marketing.measurement.meta_ad_account_identity': ok }));
      expect(noTok.reason).toBe('TOKEN_ABSENT');
    } finally { if (prev !== undefined) process.env.META_ADS_READ_TOKEN = prev; }
  });
  test('a successful pull ingests the rows and records evidence; the credential never appears in errors', async () => {
    const prev = process.env.META_ADS_READ_TOKEN; process.env.META_ADS_READ_TOKEN = 'r'.repeat(40);
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      expect(init && init.method ? init.method : 'GET').toBe('GET');
      return { ok: true, status: 200, json: async () => ({ data: [{ campaign_id: '1', campaign_name: 'Test', adset_id: '2', ad_id: '3', spend: '0', impressions: '0', clicks: '0', date_start: '2026-09-10' }] }) };
    });
    try {
      const ok = { id: 'act_123', name: 'Advantage.Bid Ads', owner_business: 'Advantage.Bid', verified_at: 'x' };
      const db = cfgDb({ 'marketing.measurement.meta_ad_account_id': 'act_123', 'marketing.measurement.meta_ad_account_identity': ok }, [[/SUM\(spend_cents\)/, [{ s: 0 }]]]);
      const out = await cost.pullMeta({ since: '2026-09-04', until: '2026-09-10' }, db);
      expect(out).toMatchObject({ pulled: true, account_id: 'act_123', rows: 1, spend_cents: 0 });
      expect(db.calls.some((c) => /INSERT INTO marketing_paid_cost_facts/.test(c.sql))).toBe(true);
      const evidence = db.calls.find((c) => /meta_verification/.test(c.sql));
      expect(JSON.parse(evidence.params[0]).cost.ok).toBe(true);
      expect(JSON.stringify(db.calls)).not.toContain('r'.repeat(40));
    } finally { spy.mockRestore(); if (prev === undefined) delete process.env.META_ADS_READ_TOKEN; else process.env.META_ADS_READ_TOKEN = prev; }
  });
});

describe('Meta reconciliation compares by standard event name', () => {
  test('first-party conversions fold onto Meta event names for meta_ads', async () => {
    const db = fakeDb([
      [/FROM marketing_paid_cost_facts WHERE provider/, [{ provider_conversions: { CompleteRegistration: 3, Lead: 1 } }]],
      [/FROM marketing_conversion_events/, [{ conversion_key: 'buyer_registered', n: 2 }, { conversion_key: 'seller_registered', n: 1 }, { conversion_key: 'assisted_service_inquiry', n: 1 }]],
      [/INSERT INTO marketing_provider_reconciliations/, [{ id: 'r1', created_at: 'x' }]],
    ]);
    const out = await recon.reconcile({ provider: 'meta_ads', campaignKey: 'facebook:hou', windowStart: '2026-09-01', windowEnd: '2026-09-10' }, db);
    expect(out.first_party).toEqual({ CompleteRegistration: 3, Lead: 1 });
    expect(out.discrepancy.CompleteRegistration.status).toBe('MATCH');
  });
});

describe('connect script safety rails', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/meta-measurement-connect.js'), 'utf8');
  test('production-guarded, scrubs every credential, never writes a paid gate, asserts paid gates OFF + shadow mode', () => {
    expect(src).toMatch(/REFUSE: staging endpoint/); expect(src).toMatch(/scrub\(/);
    expect(src).toMatch(/assertPaidOff\(\)/);
    expect(src).not.toMatch(/setCfg\('marketing\.destinations\./); expect(src).not.toMatch(/setCfg\('marketing\.paid_growth\./);
    expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);   // Graph reads only (the CAPI test event goes through metaCapiService)
  });
  test('verify sends TEST events only and removes its labelled rows', () => {
    expect(src).toMatch(/test-event-code/); expect(src).toMatch(/DELETE FROM marketing_conversion_events/); expect(src).toMatch(/DELETE FROM consent_records/);
  });
  test('the identity guard refuses a Lewis & Maese ad account and accepts an Advantage.Bid one', () => {
    expect(guard.check('meta_ad_account', 'act_1', { id: 'act_1', name: 'Lewis and Maese', owner_business: 'Lewis & Maese', verified_at: 'x' }).ok).toBe(false);
    expect(guard.check('meta_ad_account', 'act_2', { id: 'act_2', name: 'Advantage.Bid Ads', owner_business: 'Advantage.Bid', verified_at: 'x' }).ok).toBe(true);
  });
});

describe('readiness: Meta items need fresh evidence, never configuration alone', () => {
  const identity = { id: '123456789012345', name: 'Advantage.Bid', owner_business: 'Advantage.Bid', verified_at: 'x' };
  const acct = { id: 'act_123', name: 'Advantage.Bid Ads', owner_business: 'Advantage.Bid', verified_at: 'x' };
  const now = new Date().toISOString();
  const cfgRows = (evidence) => (sql, params) => {
    const k = params && params[0];
    const v = { 'marketing.measurement.meta_pixel_enabled': true, 'marketing.measurement.meta_capi_enabled': true, 'marketing.measurement.meta_cost_ingestion_enabled': true,
      'marketing.measurement.meta_dataset_id': '123456789012345', 'marketing.measurement.meta_dataset_identity': identity,
      'marketing.measurement.meta_ad_account_id': 'act_123', 'marketing.measurement.meta_ad_account_identity': acct, 'marketing.measurement.meta_verification': evidence }[k];
    return v === undefined ? { rows: [], rowCount: 0 } : { rows: [{ value: v }], rowCount: 1 };
  };
  const run = async (evidence) => {
    const prev = process.env.META_CAPI_ACCESS_TOKEN; process.env.META_CAPI_ACCESS_TOKEN = 'y'.repeat(40);
    try { return await readiness.evaluate(fakeDb([[/to_regclass/, [{ t: 'x' }]], [/FROM platform_config WHERE key=\$1/, cfgRows(evidence)]])); }
    finally { if (prev === undefined) delete process.env.META_CAPI_ACCESS_TOKEN; else process.env.META_CAPI_ACCESS_TOKEN = prev; }
  };
  test('configured + enabled but no evidence → still PARTIAL', async () => {
    const by = Object.fromEntries((await run({})).items.map((i) => [i.key, i.status]));
    expect(by.meta_pixel).toBe('PARTIAL'); expect(by.meta_capi).toBe('PARTIAL'); expect(by.meta_click_id).toBe('PARTIAL'); expect(by.cost_ingestion).toBe('PARTIAL');
  });
  test('fresh evidence → VERIFIED; the minimum set for paid activation becomes ready; retargeting stays PARTIAL (export OFF by policy)', async () => {
    const ev = { browser: { ok: true, at: now, denied: { requests: 0 } }, capi: { ok: true, at: now, events_received: 1 }, dedup: { ok: true, at: now }, click_id: { ok: true, at: now }, cost: { ok: true, at: now, rows: 0, spend_cents: 0 }, consent: { ok: true, at: now } };
    const out = await run(ev);
    const by = Object.fromEntries(out.items.map((i) => [i.key, i.status]));
    expect(by.meta_pixel).toBe('VERIFIED'); expect(by.meta_capi).toBe('VERIFIED'); expect(by.meta_click_id).toBe('VERIFIED'); expect(by.cost_ingestion).toBe('VERIFIED');
    expect(by.retargeting_audiences).toBe('PARTIAL'); expect(by.suppression).toBe('PARTIAL');
    expect(out.rules.minimum_for_any_paid_activation.ready).toBe(true);
    expect(out.rules.minimum_for_meta.ready).toBe(true);
  });
  test('stale evidence (older than its window) falls back to PARTIAL', async () => {
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    const by = Object.fromEntries((await run({ browser: { ok: true, at: old }, capi: { ok: true, at: old }, dedup: { ok: true, at: old }, click_id: { ok: true, at: old }, cost: { ok: true, at: old } })).items.map((i) => [i.key, i.status]));
    expect(by.meta_pixel).toBe('PARTIAL'); expect(by.meta_capi).toBe('PARTIAL'); expect(by.cost_ingestion).toBe('PARTIAL');
  });
});

describe('no path can create, edit, activate, pause or fund an advertisement', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
  const graphCallers = [...walk('src'), ...walk('scripts')].filter((f) => read(f).includes('graph.facebook.com'));
  test('the only Graph callers are the known four', () => {
    expect(graphCallers.map((f) => f.split(path.sep).join('/')).sort()).toEqual(['scripts/meta-measurement-connect.js', 'src/services/measurement/metaCapiService.js', 'src/services/measurement/paidCostIngestionService.js', 'src/services/metaGraphProvider.js']);
  });
  test('the cost puller and the connect script never write (GET only)', () => {
    for (const f of ['src/services/measurement/paidCostIngestionService.js', 'scripts/meta-measurement-connect.js']) expect(read(f)).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
  });
  test('the Conversions API posts only to /{dataset}/events', () => {
    const src = read('src/services/measurement/metaCapiService.js');
    expect((src.match(/method:\s*'POST'/g) || []).length).toBe(1);
    expect(src).toMatch(/\+ '\/events', \{\s*method: 'POST'/);
  });
  test('organic social publishing (separately gated, OFF) posts only to Page / Instagram post endpoints — never an ad object', () => {
    const src = read('src/services/metaGraphProvider.js');
    const posts = [...src.matchAll(/http\(([^,]+),\s*\{\s*method:\s*'POST'/g)].map((m) => m[1]);
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p).toMatch(/endpoint|\/media|\/media_publish/);
    expect(src).toMatch(/\$\{base\}\/photos` : `\$\{base\}\/feed`/);
  });
  test('no source anywhere references an ad-object write, budget, status or funding endpoint', () => {
    const AD_WRITE = /(\/adcreatives|\/customaudiences|\/adimages|funding_source|spend_cap|daily_budget|lifetime_budget|bid_amount|['"]status['"]\s*:\s*['"](ACTIVE|PAUSED)['"])/;
    for (const f of [...walk('src'), ...walk('scripts')]) expect([f, AD_WRITE.test(read(f))]).toEqual([f, false]);
  });
});

describe('Director measurement grain (campaign / ad set / ad / creative)', () => {
  const oa = require('../src/services/measurement/outcomeAttributionService');
  test('Insights fields requested cover every Director metric', () => {
    for (const f of ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks', 'ctr', 'cpc', 'cpm', 'actions']) expect(cost.META_INSIGHT_FIELDS).toContain(f);
  });
  test('one Insights row keeps names, creative, reach, link clicks, provider ratios and every action type', () => {
    const r = cost.metaInsightToRow({ campaign_id: '1', campaign_name: 'C', adset_id: '2', adset_name: 'S', ad_id: '3', ad_name: 'A', spend: '10', impressions: '2000', reach: '1500', clicks: '40', inline_link_clicks: '30', ctr: '2', cpc: '0.25', cpm: '5', date_start: '2026-09-10', actions: [{ action_type: 'link_click', value: '30' }, { action_type: 'offsite_conversion.fb_pixel_lead', value: '1' }] }, 'act_1', { 3: 'cr9' });
    const n = cost.normalise('meta_ads', r);
    expect(n).toMatchObject({ adset_name: 'S', ad_name: 'A', creative_id: 'cr9', reach: 1500, link_clicks: 30, provider_conversions: { Lead: 1 } });
    expect(n.provider_metrics).toEqual({ ctr: 2, cpc: 0.25, cpm: 5, actions: { link_click: 30, 'offsite_conversion.fb_pixel_lead': 1 } });
  });
  test('ratios are derived exactly from summed facts (never averaged) and are null when undefined', () => {
    expect(cost.derivedMetrics({ spend_cents: 1000, impressions: 2000, clicks: 40, link_clicks: 30 })).toEqual({ ctr_pct: 2, link_ctr_pct: 1.5, cpc_usd: 0.25, cost_per_link_click_usd: 0.33, cpm_usd: 5 });
    expect(cost.derivedMetrics({})).toEqual({ ctr_pct: null, link_ctr_pct: null, cpc_usd: null, cost_per_link_click_usd: null, cpm_usd: null });
  });
  test('paidBreakdown groups at the requested level and returns spend, delivery, reach, clicks, derived ratios and actions', async () => {
    const db = fakeDb([[/FROM marketing_paid_cost_facts/, [{ provider: 'meta_ads', campaign_id: '1', campaign_name: 'C', adset_id: '2', adset_name: 'S', ad_id: '3', ad_name: 'A', creative_id: 'cr9', spend_cents: '1000', impressions: '2000', clicks: '40', link_clicks: '30', reach_daily_sum: '1500', actions_daily: [{ link_click: 20 }, { link_click: 10, lead: 1 }], first_day: '2026-09-09', last_day: '2026-09-10' }]]]);
    const rows = await oa.paidBreakdown({ level: 'ad' }, db);
    expect(rows[0]).toMatchObject({ campaign_id: '1', adset_id: '2', ad_id: '3', creative_id: 'cr9', spend_cents: 1000, impressions: 2000, clicks: 40, link_clicks: 30, reach_daily_sum: 1500, ctr_pct: 2, cpc_usd: 0.25, cpm_usd: 5, actions: { link_click: 30, lead: 1 } });
    expect(db.calls[0].sql).toMatch(/GROUP BY provider, campaign_id, adset_id, ad_id/);
    await expect(oa.paidBreakdown({ level: 'keyword' }, db)).rejects.toThrow(/level must be/);
  });
});

describe('Owner-excluded ad accounts are never connected, pulled or ingested', () => {
  const OLD = 'act_664514018846795';
  test('guard: excluded regardless of the act_ prefix; other accounts unaffected', () => {
    expect(guard.isExcluded(OLD, [OLD])).toBe(true);
    expect(guard.isExcluded('664514018846795', [OLD])).toBe(true);
    expect(guard.isExcluded('act_1722514625516256', [OLD])).toBe(false);
    expect(guard.isExcluded(OLD, null)).toBe(false);
  });
  test('the puller refuses an excluded configured account before any network call', async () => {
    const spy = jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('no network'); });
    try {
      const ok = { id: OLD, name: 'Advantage.Bid Ads', owner_business: 'Advantage.Bid', verified_at: 'x' };
      const out = await cost.pullMeta({}, cfgDb({ 'marketing.measurement.meta_ad_account_id': OLD, 'marketing.measurement.meta_ad_account_identity': ok }, [[/meta_ad_account_excluded/, [{ value: [OLD] }]]]));
      expect(out).toMatchObject({ pulled: false, reason: 'EXCLUDED_BY_OWNER' }); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  test('ingestion drops rows from an excluded account even if they arrive by another path', async () => {
    const db = fakeDb([[/meta_ad_account_excluded/, [{ value: [OLD] }]], [/SUM\(spend_cents\)/, [{ s: 0 }]]]);
    const out = await cost.ingest('meta_ads', [{ campaign_id: '1', date: '2026-09-10', spend: 5, account_ref: OLD }, { campaign_id: '2', date: '2026-09-10', spend: 3, account_ref: 'act_1722514625516256' }], db);
    expect(out.excluded).toBe(1); expect(out.upserted).toBe(1);
    const inserts = db.calls.filter((c) => /INSERT INTO marketing_paid_cost_facts/.test(c.sql));
    expect(inserts.length).toBe(1); expect(inserts[0].params[1]).toBe('act_1722514625516256');
  });
  test('the connect script refuses an excluded account and the readiness audit reports it', () => {
    expect(fs.readFileSync(path.join(ROOT, 'scripts/meta-measurement-connect.js'), 'utf8')).toMatch(/is on the Owner exclusion list/);
    expect(fs.readFileSync(path.join(ROOT, 'src/services/measurement/measurementReadinessService.js'), 'utf8')).toMatch(/EXCLUDED_BY_OWNER/);
    expect(fs.readFileSync(path.join(ROOT, 'db/migrations/152_meta_ad_account_exclusion.sql'), 'utf8')).toContain('act_664514018846795');
  });
});
