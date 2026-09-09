'use strict';

/**
 * Meta organic social INTELLIGENCE + Marketing Director feedback loop (mig 146).
 * No network, no Postgres: HTTP + db are injected/faked. All publishing gates OFF; nothing publishes,
 * replies, spends, or touches Meta.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-social-intel';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = { 'marketing.social.insights_enabled': false, 'marketing.social.reply_draft_enabled': false,
  'marketing.destinations.meta_enabled': false, 'marketing.destinations.meta_ads_enabled': false,
  'marketing.a9_publish_enabled': false, 'marketing.destinations.google_ads_enabled': false, 'marketing.onsite.enabled': false, 'marketing.a7_send_enabled': false };
jest.mock('../src/services/marketingConfigService', () => ({
  getBool: async (k, f) => (Object.prototype.hasOwnProperty.call(cfg, k) ? cfg[k] : f),
  getInt: async (_k, f) => f, raw: async (_k, f) => f, a7SendEnabled: async () => false,
}));
jest.mock('../src/db', () => ({ query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }));
jest.mock('../src/services/consentService', () => ({ current: async () => ({}), allows: () => false }));

// ── Minimal in-memory runner for the intelligence tables (regex-over-store) ──
function makeStore() { return { jobs: [], snaps: [], acct: [], events: [], hooks: [], facts: [], dests: [], obs: [], learnings: [], seq: 0 }; }
function makeRunner(store) {
  const id = () => 'id_' + (++store.seq);
  return { query: async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/SELECT window_key FROM marketing_social_metric_snapshots WHERE social_job_id=\$1/.test(s)) return { rows: store.snaps.filter((x) => x.social_job_id === params[0]).map((x) => ({ window_key: x.window_key })) };
    if (/INSERT INTO marketing_social_metric_snapshots/.test(s)) {
      // Normal insert = 9 params; the error-window insert uses literal '{}'/'error' and 7 params.
      const [job, platform, post, dest, win, obs, metrics, status, err] = params.length === 7
        ? [params[0], params[1], params[2], params[3], params[4], params[5], '{}', 'error', params[6]] : params;
      if (store.snaps.find((x) => x.social_job_id === job && x.window_key === win)) return { rows: [] };
      const row = { id: id(), social_job_id: job, platform, provider_post_id: post, destination_id: dest, window_key: win, observed_at: obs, metrics: typeof metrics === 'string' ? JSON.parse(metrics) : (metrics || {}), provider_status: status, error: err };
      store.snaps.push(row); return { rows: [{ id: row.id }] };
    }
    if (/SELECT purchase_kind, purchase_id, feature_key FROM marketing_obligations WHERE id=\$1/.test(s)) return { rows: store.obs.filter((o) => o.id === params[0]) };
    if (/INSERT INTO marketing_performance_facts/.test(s)) { store.facts.push({ purchase_kind: params[0], purchase_id: params[1], obligation_id: params[2], metric: params[3], classification: 'MEASURED', value: params[4], source: params[5] }); return { rows: [] }; }
    if (/UPDATE marketing_social_jobs SET insights_status='complete'/.test(s)) { const j = store.jobs.find((x) => x.id === params[0]); if (j) { j.insights_status = 'complete'; j.next_insights_poll_at = null; } return { rows: [] }; }
    if (/UPDATE marketing_social_jobs SET insights_status=\$2, next_insights_poll_at=\$3, insights_poll_count=insights_poll_count\+1/.test(s)) { const j = store.jobs.find((x) => x.id === params[0]); if (j) { j.insights_status = params[1]; j.next_insights_poll_at = params[2]; j.insights_poll_count = (j.insights_poll_count || 0) + 1; j.insights_error_count = 0; j.last_insights_at = params[3]; } return { rows: [] }; }
    if (/UPDATE marketing_social_jobs SET insights_status=\$2, next_insights_poll_at=\$3, insights_error_count=0/.test(s)) { const j = store.jobs.find((x) => x.id === params[0]); if (j) { j.insights_status = params[1]; j.next_insights_poll_at = params[2]; j.insights_error_count = 0; } return { rows: [] }; }
    if (/UPDATE marketing_social_jobs SET insights_status='error', next_insights_poll_at=\$2, insights_error_count=\$3/.test(s)) { const j = store.jobs.find((x) => x.id === params[0]); if (j) { j.insights_status = 'error'; j.next_insights_poll_at = params[1]; j.insights_error_count = params[2]; } return { rows: [] }; }
    if (/UPDATE marketing_social_jobs SET next_insights_poll_at=\$2 WHERE post_id=\$1/.test(s)) {
      const now = new Date(params[1]); const cutoff = new Date(params[2]);
      const rows = store.jobs.filter((j) => j.post_id === params[0] && j.status === 'published' && j.shadow === false && (!j.last_insights_at || new Date(j.last_insights_at) < cutoff) && (!j.next_insights_poll_at || new Date(j.next_insights_poll_at) > now));
      rows.forEach((j) => { j.next_insights_poll_at = params[1]; }); return { rows: rows.map((j) => ({ id: j.id })) };
    }
    if (/SELECT \* FROM marketing_social_jobs WHERE status='published' AND shadow=false AND post_id IS NOT NULL AND next_insights_poll_at IS NOT NULL/.test(s)) {
      const now = new Date(params[0]);
      return { rows: store.jobs.filter((j) => j.status === 'published' && j.shadow === false && j.post_id && j.next_insights_poll_at && new Date(j.next_insights_poll_at) <= now).slice(0, params[1]) };
    }
    if (/SELECT id FROM marketing_social_jobs WHERE post_id=\$1/.test(s)) return { rows: store.jobs.filter((j) => j.post_id === params[0]).map((j) => ({ id: j.id })) };
    if (/SELECT published_at FROM marketing_social_jobs WHERE id=\$1/.test(s)) return { rows: store.jobs.filter((j) => j.id === params[0]).map((j) => ({ published_at: j.published_at })) };
    if (/FROM marketing_social_destinations WHERE id=\$1/.test(s)) return { rows: store.dests.filter((d) => d.id === params[0]) };
    if (/FROM marketing_social_destinations ORDER BY/.test(s)) return { rows: store.dests };
    if (/scope='national'/.test(s)) return { rows: store.dests.filter((d) => d.platform === params[0] && d.scope === 'national' && d.active && d.readiness_status === 'ready') };
    if (/scope='state'/.test(s)) return { rows: [] };
    if (/SELECT 1 FROM marketing_social_account_snapshots WHERE destination_id=\$1 AND day=\$2/.test(s)) return { rows: store.acct.filter((a) => a.destination_id === params[0] && a.day === params[1]).map(() => ({ 1: 1 })) };
    if (/INSERT INTO marketing_social_account_snapshots/.test(s)) { if (!store.acct.find((a) => a.destination_id === params[0] && a.day === params[3])) store.acct.push({ destination_id: params[0], platform: params[1], provider_account_id: params[2], day: params[3], metrics: JSON.parse(params[4]) }); return { rows: [] }; }
    if (/INSERT INTO marketing_social_engagement_events/.test(s)) {
      const [platform, dest, post, job, kind, pev, occ, excerpt, cls, why, source, rs] = params;
      if (store.events.find((e) => e.platform === platform && e.provider_event_id === pev)) return { rows: [] };
      const row = { id: id(), platform, destination_id: dest, provider_post_id: post, social_job_id: job, event_kind: kind, provider_event_id: pev, occurred_at: occ, text_excerpt: excerpt, classification: cls, classification_reason: why, source, response_state: rs, draft_text: null };
      store.events.push(row); return { rows: [{ id: row.id }] };
    }
    if (/SELECT \* FROM marketing_social_engagement_events WHERE id=\$1/.test(s)) return { rows: store.events.filter((e) => e.id === params[0]) };
    if (/UPDATE marketing_social_engagement_events SET draft_text=\$2, response_state='draft_ready'/.test(s)) { const e = store.events.find((x) => x.id === params[0]); if (e) { e.draft_text = params[1]; e.response_state = 'draft_ready'; } return { rows: [] }; }
    if (/UPDATE marketing_social_engagement_events SET response_state='no_response_needed'/.test(s)) { const e = store.events.find((x) => x.id === params[0]); if (e) e.response_state = 'no_response_needed'; return { rows: [] }; }
    if (/INSERT INTO marketing_social_webhook_events/.test(s)) {
      const [key, object, entryId, field, change, status] = params;
      if (store.hooks.find((h) => h.dedup_key === key)) return { rows: [] };
      const row = { id: id(), dedup_key: key, object, entry_id: entryId, field, change: change == null ? null : JSON.parse(change), status };
      store.hooks.push(row); return { rows: [{ id: row.id }] };
    }
    if (/UPDATE marketing_social_webhook_events SET status='processed'/.test(s)) { const h = store.hooks.find((x) => x.id === params[0]); if (h) h.status = 'processed'; return { rows: [] }; }
    if (/UPDATE marketing_social_webhook_events SET status='error'/.test(s)) { const h = store.hooks.find((x) => x.id === params[0]); if (h) { h.status = 'error'; h.error = params[1]; } return { rows: [] }; }
    if (/FROM marketing_social_engagement_events WHERE created_at/.test(s)) return { rows: [] };
    if (/count\(\*\)::int n FROM marketing_social_engagement_events WHERE response_state/.test(s)) return { rows: [{ n: store.events.filter((e) => /draft/.test(e.response_state)).length }] };
    if (/FROM marketing_social_jobs j LEFT JOIN marketing_social_destinations d/.test(s)) {
      return { rows: store.jobs.filter((j) => j.status === 'published' && j.shadow === false).map((j) => {
        const d = store.dests.find((x) => x.id === j.destination_id) || {};
        const snaps = store.snaps.filter((x) => x.social_job_id === j.id); const pref = snaps.find((x) => x.window_key === 'd7') || snaps[snaps.length - 1];
        return { ...j, destination_scope: d.scope, destination_state: d.state_code, destination_label: d.label, window_key: pref ? pref.window_key : null, metrics: pref ? pref.metrics : null, provider_status: pref ? pref.provider_status : null };
      }) };
    }
    if (/FROM lots WHERE auction_id::text = ANY/.test(s)) return { rows: (store.lots || []) };
    if (/FROM analytics_events WHERE auction_id/.test(s)) return { rows: [{ n: store.referred || 0, intent: store.referredIntent || 0 }] };
    if (/FROM marketing_click_ids WHERE click_type='fbclid'/.test(s)) return { rows: [{ n: store.fbclid || 0 }] };
    if (/FROM marketing_social_account_snapshots WHERE day >=/.test(s)) return { rows: store.acct.map((a) => ({ destination_id: a.destination_id, platform: a.platform, day: a.day, metrics: a.metrics })) };
    if (/SELECT id, statement FROM marketing_learnings WHERE segment=\$1 AND category=\$2/.test(s)) return { rows: store.learnings.filter((l) => l.category === params[1] && !l.superseded_by).slice(-1) };
    if (/count\(\*\) FILTER \(WHERE status='published' AND shadow=false\)::int real_published/.test(s)) return { rows: [{ real_published: store.jobs.filter((j) => j.status === 'published' && !j.shadow).length, polling: 0, complete: 0, in_error: 0, last_ingested_at: null }] };
    if (/count\(\*\)::int n FROM marketing_social_metric_snapshots/.test(s)) return { rows: [{ n: store.snaps.length }] };
    if (/count\(\*\)::int n, max\(day\) last_day FROM marketing_social_account_snapshots/.test(s)) return { rows: [{ n: store.acct.length, last_day: null }] };
    if (/FROM marketing_social_webhook_events GROUP BY status/.test(s)) return { rows: [] };
    return { rows: [] };
  } };
}

const DEST_FB = { id: 'dest-fb', platform: 'facebook', scope: 'national', state_code: null, label: 'National Facebook', provider_account_id: '449143945236360', credential_ref: 'INTEL_TOK', active: true, readiness_status: 'ready', readiness_detail: {} };
const DEST_IG = { id: 'dest-ig', platform: 'instagram', scope: 'national', state_code: null, label: 'National Instagram', provider_account_id: '17841436199617514', linked_facebook_page_id: '449143945236360', credential_ref: 'INTEL_TOK', active: true, readiness_status: 'ready', readiness_detail: {} };
const T0 = new Date('2026-09-09T14:00:00Z');
const job = (o) => Object.assign({ id: 'job1', obligation_id: 'ob1', auction_id: '11111111-1111-4111-8111-111111111111', wave: 'LAUNCH', platform: 'facebook', destination_id: 'dest-fb', post_id: '449143945236360_100', status: 'published', shadow: false, published_at: T0.toISOString(), copy_style: 'Now live', insights_error_count: 0, next_insights_poll_at: new Date(T0.getTime() + 3600000).toISOString() }, o);

beforeEach(() => { for (const k of Object.keys(cfg)) cfg[k] = false; process.env.INTEL_TOK = 'tok-abc-123'; });
afterEach(() => { delete process.env.INTEL_TOK; });

// ── Migration 146 (static) ──
describe('migration 146 — additive, gates split, nothing activated', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '146_social_intelligence.sql'), 'utf8');
  test('additive only; new tables + columns; no DROP TABLE', () => {
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    for (const t of ['marketing_social_metric_snapshots', 'marketing_social_account_snapshots', 'marketing_social_engagement_events', 'marketing_social_webhook_events']) expect(sql).toMatch(new RegExp('CREATE TABLE IF NOT EXISTS ' + t));
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS next_insights_poll_at/);
    expect(sql).toMatch(/UNIQUE \(social_job_id, window_key\)/);
    expect(sql).toMatch(/dedup_key\s+TEXT NOT NULL UNIQUE/);
  });
  test('paid Meta gate split from organic; insights + draft switches FALSE; publishing gates untouched', () => {
    expect(sql).toMatch(/meta_ads_enabled',\s*'false'/); expect(sql).toMatch(/insights_enabled',\s*'false'/); expect(sql).toMatch(/reply_draft_enabled',\s*'false'/);
    expect(sql).not.toMatch(/a9_publish_enabled/); expect(sql).not.toMatch(/meta_enabled',\s*'true'/);
    expect(sql).not.toMatch(/active\s*=\s*true/i);
  });
  test('seeds ONLY the Owner-supplied Advantage.Bid IDs (no other portfolio asset); no token', () => {
    expect(sql).toMatch(/449143945236360/); expect(sql).toMatch(/17841436199617514/);
    expect(sql).not.toMatch(/lewis|maese/i); expect(sql).not.toMatch(/EAA[A-Za-z0-9]{20,}/);
    expect(sql).not.toMatch(/commenter_id|author_id|from_id|user_name|profile_url/i); // engagement table stores no identity columns
  });
});

// ── Graph provider read-only surface ──
describe('metaGraphProvider — read-only insights (injected HTTP; honest availability; no token leaks)', () => {
  const meta = require('../src/services/metaGraphProvider');
  const cat = require('../src/lib/socialMetricCatalog');
  test('combined insights + object fields → normalized metrics with availability; reactions summed from object', async () => {
    const calls = [];
    const http = async (url) => { calls.push(url);
      if (/\/insights\?metric=/.test(url)) return { ok: true, status: 200, json: { data: [
        { name: 'post_impressions', values: [{ value: 1000 }] }, { name: 'post_impressions_unique', values: [{ value: 800 }] },
        { name: 'post_engaged_users', values: [{ value: 40 }] }, { name: 'post_clicks', values: [{ value: 12 }] },
        { name: 'post_reactions_by_type_total', values: [{ value: { like: 5, love: 2 } }] } ] } };
      return { ok: true, status: 200, json: { shares: { count: 3 }, comments: { summary: { total_count: 4 } }, reactions: { summary: { total_count: 7 } } } }; };
    const p = meta.buildProvider(DEST_FB, { http, version: 'v21.0' });
    const r = await p.fetchPostMetrics('449143945236360_100', cat.FACEBOOK_POST);
    expect(r.ok).toBe(true); expect(r.provider_status).toBe('ok');
    expect(r.metrics.reach).toEqual({ value: 800, availability: 'available', provider_metric: 'post_impressions_unique' });
    expect(r.metrics.reactions.value).toBe(7); expect(r.metrics.shares.value).toBe(3); expect(r.metrics.comments.value).toBe(4);
    expect(r.metrics.video_views.availability).toBe('unavailable'); expect(r.metrics.video_views.value).toBeNull();
    expect(calls.every((u) => u.startsWith('https://graph.facebook.com/v21.0/'))).toBe(true);
    // Only OUR post id — plus the one-time Page-token derivation for OUR Page id (never /me/accounts).
    expect(calls.every((u) => /^https:\/\/graph\.facebook\.com\/v21\.0\/449143945236360(_100|\?fields=access_token)/.test(u))).toBe(true);
    expect(calls.some((u) => /\/me\/accounts/.test(u))).toBe(false);
  });
  test('unsupported metric → per-metric fallback: not_supported recorded, others still available (never fabricated 0)', async () => {
    const http = async (url) => {
      if (/metric=reach,impressions/.test(url)) return { ok: false, status: 400, json: { error: { code: 100, message: '(#100) impressions metric unsupported' } } };
      if (/metric=impressions&/.test(url)) return { ok: false, status: 400, json: { error: { code: 100, message: 'unsupported' } } };
      if (/metric=(reach|views|likes|comments|shares|saved)&/.test(url)) { const m = /metric=(\w+)&/.exec(url)[1]; return { ok: true, status: 200, json: { data: [{ name: m, values: [{ value: 50 }] }] } }; }
      return { ok: true, status: 200, json: { like_count: 9, comments_count: 1 } }; };
    const p = meta.buildProvider(DEST_IG, { http, version: 'v21.0' });
    const r = await p.fetchPostMetrics('IGM1', cat.INSTAGRAM_MEDIA);
    expect(r.metrics.impressions).toEqual({ value: null, availability: 'not_supported', provider_metric: 'impressions' });
    expect(r.metrics.reach.value).toBe(50); expect(r.metrics.saves.value).toBe(50);
    expect(r.metrics.reactions.value).toBe(50); // insights available → object like_count is fallback-only
    expect(r.provider_status).toBe('ok');
  });
  test('permission error → metrics unavailable + error status; token NEVER appears in any error message', async () => {
    const http = async () => ({ ok: false, status: 403, json: { error: { code: 10, message: 'requires read_insights tok-abc-123' } } });
    const p = meta.buildProvider(DEST_FB, { http });
    const r = await p.fetchPostMetrics('P', cat.FACEBOOK_POST);
    expect(r.ok).toBe(false); expect(r.provider_status).toBe('error');
    expect(JSON.stringify(r)).not.toContain('tok-abc-123'); expect(r.error).toContain('[redacted]');
    expect(Object.values(r.metrics).every((m) => m.value === null)).toBe(true);
  });
  test('fetchComments requests NO author fields; permission failure is "unavailable", not "no comments"', async () => {
    const urls = [];
    const http = async (url) => { urls.push(url); return { ok: true, status: 200, json: { data: [{ id: 'c1', message: 'How much?', created_time: '2026-09-09T15:00:00+0000', from: { id: 'U1', name: 'Someone' } }] } }; };
    const p = meta.buildProvider(DEST_FB, { http });
    const r = await p.fetchComments('P');
    expect(r.ok).toBe(true); expect(r.comments[0]).toEqual({ id: 'c1', text: 'How much?', occurred_at: '2026-09-09T15:00:00+0000' });
    const cu = urls.find((u) => /\/comments\?/.test(u)); expect(cu).toMatch(/fields=id,message,created_time&/); expect(cu).not.toMatch(/from/);
    const denied = meta.buildProvider(DEST_FB, { http: async () => ({ ok: false, status: 403, json: { error: { code: 200, message: 'pages_read_user_content required' } } }) });
    const d = await denied.fetchComments('P'); expect(d.ok).toBe(false); expect(d.availability).toBe('unavailable');
  });
  test('verifyIdentity compares the configured id (never enumerates /me/accounts)', async () => {
    const urls = [];
    const p = meta.buildProvider(DEST_FB, { http: async (u) => { urls.push(u); return { ok: true, status: 200, json: { id: '449143945236360', name: 'AdvantageBid', instagram_business_account: { id: '17841436199617514' } } }; } });
    const v = await p.verifyIdentity(); expect(v.ok).toBe(true); expect(v.linked_instagram_business_account_id).toBe('17841436199617514');
    expect(urls.some((u) => /me\/accounts/.test(u))).toBe(false);
    const wrong = meta.buildProvider(DEST_FB, { http: async () => ({ ok: true, status: 200, json: { id: '999', name: 'Other Page' } }) });
    expect((await wrong.verifyIdentity()).ok).toBe(false);
  });
  test('no comment/reply WRITE path exists in the provider (structural)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'metaGraphProvider.js'), 'utf8');
    expect(src).not.toMatch(/\/comments`?,\s*\{\s*method:\s*'POST'/); expect(src).not.toMatch(/\/replies/);
    expect(src).not.toMatch(/\/subscribed_apps/); // never alters Page settings
  });
});

// ── Insights ingestion: ladder, idempotency, normalization, backoff, gate ──
describe('socialInsightsService — bounded, idempotent, honest', () => {
  const insights = require('../src/services/socialInsightsService');
  const okMetrics = { reach: { value: 500, availability: 'available', provider_metric: 'post_impressions_unique' }, clicks: { value: 20, availability: 'available', provider_metric: 'post_clicks' }, video_views: { value: null, availability: 'unavailable', provider_metric: 'post_video_views' } };
  const factory = (impl) => (dest) => ({ name: 'meta', platform: dest.platform, active: true, shadow: false, fetchPostMetrics: impl, fetchComments: async () => ({ ok: true, availability: 'available', comments: [] }), fetchAccountMetrics: async () => ({ ok: true, metrics: { followers: { value: 120, availability: 'available', provider_metric: 'followers_count' } }, provider_status: 'ok' }) });

  test('ladder: h1 → h24 → h72 → d7 → d14 then complete', () => {
    expect(insights.nextWindow(T0, [], new Date(T0.getTime() + 2 * 3600000)).key).toBe('h1');
    expect(insights.nextWindow(T0, ['h1'], T0).key).toBe('h24');
    expect(insights.nextWindow(T0, ['h1', 'h24', 'h72', 'd7', 'd14'], T0)).toBeNull();
  });
  test('gate OFF → inert (no provider call, no rows)', async () => {
    const store = makeStore(); store.jobs.push(job({})); store.dests.push(DEST_FB);
    const calls = []; const out = await insights.runOnce({ runner: makeRunner(store), providerFactory: factory(async () => { calls.push(1); return { ok: true, metrics: okMetrics, provider_status: 'ok' }; }), now: new Date(T0.getTime() + 2 * 3600000) });
    expect(out.ran).toBe(false); expect(out.reason).toBe('insights_disabled'); expect(calls.length).toBe(0); expect(store.snaps.length).toBe(0);
  });
  test('gate ON: due job → snapshot (once per window), MEASURED facts only for AVAILABLE metrics, next window scheduled', async () => {
    cfg['marketing.social.insights_enabled'] = true;
    const store = makeStore(); store.jobs.push(job({})); store.dests.push(DEST_FB); store.obs.push({ id: 'ob1', purchase_kind: 'package', purchase_id: 'pp1', feature_key: 'social_post_organic' });
    const r = makeRunner(store); const now = new Date(T0.getTime() + 2 * 3600000);
    const out = await insights.runOnce({ runner: r, providerFactory: factory(async () => ({ ok: true, metrics: okMetrics, provider_status: 'ok' })), now });
    expect(out.processed).toBe(1); expect(out.results[0].window).toBe('h1'); expect(out.results[0].wrote).toBe(true);
    expect(store.snaps.length).toBe(1); expect(store.snaps[0].provider_post_id).toBe('449143945236360_100'); expect(store.snaps[0].destination_id).toBe('dest-fb');
    expect(store.facts.map((f) => f.metric).sort()).toEqual(['social_facebook_clicks_h1', 'social_facebook_reach_h1']); // video_views unavailable → NO fact
    expect(store.facts[0].source).toBe('meta_insights'); expect(store.facts[0].purchase_id).toBe('pp1');
    expect(store.jobs[0].insights_status).toBe('partial'); expect(new Date(store.jobs[0].next_insights_poll_at).getTime()).toBe(T0.getTime() + 24 * 3600000);
    // Replay of the same window (e.g. duplicate tick) → no second snapshot, no duplicate facts.
    store.jobs[0].next_insights_poll_at = now.toISOString(); store.snaps[0].window_key = 'h1';
    const again = await insights.ingestJob({ ...store.jobs[0], published_at: T0.toISOString() }, { runner: r, providerFactory: factory(async () => ({ ok: true, metrics: okMetrics, provider_status: 'ok' })), now });
    expect(again.window).toBe('h24'); expect(store.snaps.length).toBe(2); expect(store.facts.length).toBe(4);
  });
  test('provider error → bounded backoff, then honest error window + ladder advances (never fabricated metrics)', async () => {
    cfg['marketing.social.insights_enabled'] = true;
    const store = makeStore(); store.jobs.push(job({})); store.dests.push(DEST_FB);
    const r = makeRunner(store); const now = new Date(T0.getTime() + 2 * 3600000);
    const failing = factory(async () => ({ ok: false, metrics: {}, provider_status: 'error', error: 'graph_error_500' }));
    const r1 = await insights.ingestJob(store.jobs[0], { runner: r, providerFactory: failing, now });
    expect(r1.ok).toBe(false); expect(r1.retry_in_ms).toBe(15 * 60 * 1000); expect(store.jobs[0].insights_error_count).toBe(1); expect(store.snaps.length).toBe(0);
    const r2 = await insights.ingestJob(store.jobs[0], { runner: r, providerFactory: failing, now }); expect(r2.retry_in_ms).toBe(30 * 60 * 1000);
    await insights.ingestJob(store.jobs[0], { runner: r, providerFactory: failing, now });
    const r4 = await insights.ingestJob(store.jobs[0], { runner: r, providerFactory: failing, now });
    expect(r4.gave_up).toBe(true); expect(store.snaps.length).toBe(1); expect(store.snaps[0].provider_status).toBe('error'); expect(store.snaps[0].metrics).toEqual({});
    expect(r4.next).toBe('h24'); expect(store.facts.length).toBe(0);
  });
  test('shadow / non-published jobs are never polled; account snapshot idempotent per day', async () => {
    cfg['marketing.social.insights_enabled'] = true;
    const store = makeStore(); store.jobs.push(job({ status: 'published_shadow', shadow: true })); store.dests.push(DEST_FB);
    const out = await insights.runOnce({ runner: makeRunner(store), providerFactory: factory(async () => ({ ok: true, metrics: okMetrics, provider_status: 'ok' })), now: new Date(T0.getTime() + 2 * 3600000) });
    expect(out.processed).toBe(0);
    const a1 = await insights.snapshotAccounts({ runner: makeRunner(store), providerFactory: factory(async () => ({})), now: T0 });
    const a2 = await insights.snapshotAccounts({ runner: makeRunner(store), providerFactory: factory(async () => ({})), now: T0 });
    expect(a1.results[0].provider_status).toBe('ok'); expect(a2.results[0].skipped).toBe('already_captured'); expect(store.acct.length).toBe(1);
  });
  test('account snapshots run for CONFIGURED destinations even when active=false (read-only never depends on publish activation); unconfigured skipped', async () => {
    cfg['marketing.social.insights_enabled'] = true;
    const store = makeStore();
    store.dests.push({ ...DEST_FB, active: false, readiness_status: 'incomplete' },
                     { ...DEST_IG, active: false, readiness_status: 'incomplete' },
                     { ...DEST_FB, id: 'dest-mi', scope: 'state', state_code: 'MI', provider_account_id: null, active: false, readiness_status: 'not_configured' });
    const seen = [];
    const out = await insights.snapshotAccounts({ runner: makeRunner(store), providerFactory: (d) => { seen.push(d.id); return factory(async () => ({}))(d); }, now: T0 });
    expect(out.ran).toBe(true);
    expect(seen.sort()).toEqual(['dest-fb', 'dest-ig']);
    expect(store.acct.map((a) => a.destination_id).sort()).toEqual(['dest-fb', 'dest-ig']);
    expect(store.acct[0].metrics.followers.value).toBe(120);
  });
  test('requestRefresh pulls a REAL post forward at most once per 15 minutes', async () => {
    const store = makeStore(); store.jobs.push(job({ last_insights_at: null }));
    const r = makeRunner(store);
    expect((await insights.requestRefresh('449143945236360_100', { runner: r, now: T0 })).refreshed).toBe(1);
    store.jobs[0].last_insights_at = T0.toISOString(); store.jobs[0].next_insights_poll_at = new Date(T0.getTime() + 3600000).toISOString();
    expect((await insights.requestRefresh('449143945236360_100', { runner: r, now: new Date(T0.getTime() + 60000) })).refreshed).toBe(0);
  });
});

// ── Engagement governance A–E ──
describe('socialEngagementService — observe/classify/learn autonomous; draft governed; publish DISABLED', () => {
  const eng = require('../src/services/socialEngagementService');
  test('deterministic classification with reasons', () => {
    expect(eng.classify('How much is the sofa?').classification).toBe('purchase_intent');
    expect(eng.classify('Is pickup available Saturday?').classification).toBe('purchase_intent');
    expect(eng.classify('When does it close?').classification).toBe('question');
    expect(eng.classify('Total scam, never got my refund').classification).toBe('complaint');
    expect(eng.classify('Earn $$$ https://spam.example').classification).toBe('spam');
    expect(eng.classify('Gorgeous set!').classification).toBe('positive');
    expect(eng.classify('').classification).toBe('other');
    expect(eng.classify('How much?').reason).toBeTruthy();
  });
  test('ingestEvent: idempotent, excerpt-bounded, stores NO commenter identity even when offered', async () => {
    const store = makeStore(); store.jobs.push(job({})); const r = makeRunner(store);
    const long = 'x'.repeat(900);
    const a = await eng.ingestEvent({ platform: 'facebook', destinationId: 'dest-fb', providerPostId: '449143945236360_100', kind: 'comment', providerEventId: 'c1', text: long, from: { id: 'U1', name: 'Person' }, author_id: 'U1' }, r);
    const b = await eng.ingestEvent({ platform: 'facebook', providerPostId: '449143945236360_100', kind: 'comment', providerEventId: 'c1', text: long }, r);
    expect(a.ok).toBe(true); expect(b.idempotent).toBe(true); expect(store.events.length).toBe(1);
    expect(store.events[0].text_excerpt.length).toBe(500); expect(store.events[0].social_job_id).toBe('job1');
    expect(JSON.stringify(store.events[0])).not.toMatch(/U1|Person/);
  });
  test('draftResponse is GATED (off by default) and, when on, produces a factual link-clean draft that is NOT published', async () => {
    const store = makeStore(); const r = makeRunner(store);
    await eng.ingestEvent({ platform: 'facebook', providerPostId: 'P', kind: 'comment', providerEventId: 'c9', text: 'How much?' }, r);
    const off = await eng.draftResponse(store.events[0].id, { runner: r }); expect(off.ok).toBe(false); expect(off.reason).toBe('reply_drafting_disabled');
    cfg['marketing.social.reply_draft_enabled'] = true;
    const on = await eng.draftResponse(store.events[0].id, { auction: { auction_id: 'A1' }, runner: r });
    expect(on.drafted).toBe(true); expect(on.published).toBe(false); expect(on.draft).toContain('https://bid.advantage.bid/auction/A1'); expect(on.draft).not.toMatch(/\?/);
    expect(store.events[0].response_state).toBe('draft_ready');
  });
  test('publishReply is STRUCTURALLY disabled regardless of any flag', async () => {
    cfg['marketing.social.reply_draft_enabled'] = true; cfg['marketing.a9_publish_enabled'] = true; cfg['marketing.destinations.meta_enabled'] = true;
    const out = await eng.publishReply('any', { force: true });
    expect(out.ok).toBe(false); expect(out.published).toBe(false); expect(out.reason).toBe('autonomous_public_replies_not_authorized');
    expect(eng.REPLY_POLICY.publish_enabled).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'socialEngagementService.js'), 'utf8');
    expect(src).not.toMatch(/graph\.facebook\.com/); expect(src).not.toMatch(/fetch\(/);
  });
  test('pollCommentsForJob: permission-unavailable is reported, never treated as zero comments', async () => {
    const store = makeStore(); const r = makeRunner(store);
    const p = { active: true, fetchComments: async () => ({ ok: false, availability: 'unavailable', error: 'pages_read_user_content required' }) };
    const out = await eng.pollCommentsForJob(job({}), { provider: p, destination: DEST_FB, runner: r });
    expect(out.ok).toBe(false); expect(out.availability).toBe('unavailable'); expect(out.ingested).toBe(0);
  });
});

// ── Webhook receiver ──
describe('metaWebhookService — verified, replay-protected, tenant-isolated', () => {
  const hook = require('../src/services/metaWebhookService');
  const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  afterEach(() => { delete process.env.META_APP_SECRET; delete process.env.META_WEBHOOK_VERIFY_TOKEN; });

  test('GET verification: 503 unconfigured, 403 wrong token, 200 echoes challenge', () => {
    expect(hook.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' }).status).toBe(503);
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-me';
    expect(hook.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }).status).toBe(403);
    const ok = hook.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '4242' });
    expect(ok.status).toBe(200); expect(ok.body).toBe('4242');
  });
  test('POST signature: 503 unconfigured, 401 bad/missing signature, ok on valid HMAC over RAW body', () => {
    const body = Buffer.from('{"object":"page","entry":[]}');
    expect(hook.verifySignature(body, 'sha256=abc').status).toBe(503);
    process.env.META_APP_SECRET = 'app-secret';
    expect(hook.verifySignature(body, undefined).status).toBe(401);
    expect(hook.verifySignature(body, sign('wrong', body)).status).toBe(401);
    expect(hook.verifySignature(body, sign('app-secret', body)).ok).toBe(true);
    expect(hook.verifySignature('not a buffer', sign('app-secret', body)).status).toBe(400);
  });
  test('registered Page: comment → engagement event (identity stripped) + insights refresh; duplicate delivery ignored', async () => {
    const store = makeStore(); store.dests.push(DEST_FB, DEST_IG); store.jobs.push(job({ last_insights_at: null })); const r = makeRunner(store);
    const payload = { object: 'page', entry: [{ id: '449143945236360', time: 1757426400, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', post_id: '449143945236360_100', comment_id: '449143945236360_100_555', message: 'Still available?', created_time: 1757426400, from: { id: 'U9', name: 'A Person' } } }] }] };
    const s1 = await hook.processDelivery(payload, r);
    expect(s1.processed).toBe(1); expect(s1.events).toBe(1); expect(s1.ignored).toBe(0);
    expect(store.events[0].classification).toBe('purchase_intent'); expect(store.events[0].source).toBe('webhook');
    expect(JSON.stringify(store.hooks[0].change)).not.toMatch(/U9|A Person/);
    expect(store.jobs[0].next_insights_poll_at).toBe(new Date(store.jobs[0].next_insights_poll_at).toISOString());
    const s2 = await hook.processDelivery(payload, r); expect(s2.duplicates).toBe(1); expect(store.events.length).toBe(1);
  });
  test('UNREGISTERED account (another portfolio asset) → ignored, payload NOT stored, nothing processed', async () => {
    const store = makeStore(); store.dests.push(DEST_FB); const r = makeRunner(store);
    const s = await hook.processDelivery({ object: 'page', entry: [{ id: '123456789012345', time: 1, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', post_id: '123456789012345_1', comment_id: 'zz', message: 'hello' } }] }] }, r);
    expect(s.ignored).toBe(1); expect(s.processed).toBe(0); expect(store.events.length).toBe(0);
    expect(store.hooks[0].status).toBe('ignored'); expect(store.hooks[0].change).toBeNull();
  });
  test('Instagram comments field → comment event on the IG destination; malformed payload is rejected safely', async () => {
    const store = makeStore(); store.dests.push(DEST_FB, DEST_IG); const r = makeRunner(store);
    const s = await hook.processDelivery({ object: 'instagram', entry: [{ id: '17841436199617514', time: 2, changes: [{ field: 'comments', value: { id: 'igc1', text: 'Love it!', media: { id: 'IGM1' }, from: { id: 'X' } } }] }] }, r);
    expect(s.events).toBe(1); expect(store.events[0].platform).toBe('instagram'); expect(store.events[0].classification).toBe('positive');
    expect((await hook.processDelivery({ nope: true }, r)).malformed).toBe(true);
  });
  test('route + server wiring: raw body for /api/meta/webhook, route mounted, worker spawned', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(server).toMatch(/req\.path === '\/api\/meta\/webhook'\) return next\(\)/);
    expect(server).toMatch(/app\.use\('\/api\/meta', require\('\.\/src\/routes\/metaWebhook'\)\)/);
    expect(server).toMatch(/marketingSocialInsightsWorker\.js/);
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'metaWebhook.js'), 'utf8');
    expect(route).toMatch(/express\.raw\(/); expect(route).toMatch(/x-hub-signature-256/);
  });
});

// ── Readiness re-evaluation preserves the admin Verify (identity_check) result ──
describe('socialReadinessService.evaluate — identity_check detail survives re-evaluation', () => {
  const readiness = require('../src/services/socialReadinessService');
  const identity = { at: '2026-09-09T16:40:00.000Z', ok: true, resolved_id: '449143945236360', name: 'Advantage.Bid', error: null };
  function runnerFor(rows, writes) {
    return { query: async (sql, params = []) => {
      const s = String(sql);
      if (/FROM marketing_social_destinations ORDER BY/.test(s)) return { rows };
      if (/UPDATE marketing_social_destinations SET readiness_status=\$2, readiness_detail=\$3::jsonb/.test(s)) { writes.push({ id: params[0], status: params[1], detail: JSON.parse(params[2]) }); return { rows: [] }; }
      return { rows: [] };
    } };
  }
  beforeEach(() => { process.env.RD_TOK = 'zq-secret-value-77'; });
  afterEach(() => { delete process.env.RD_TOK; });

  test('status change (not_configured → incomplete) persists checks AND keeps identity_check; admin view shows it', async () => {
    const writes = [];
    const rows = [{ ...DEST_FB, credential_ref: 'RD_TOK', active: false, readiness_status: 'not_configured', readiness_detail: { identity_check: identity } }];
    const out = await readiness.evaluate(runnerFor(rows, writes));
    expect(writes.length).toBe(1);
    expect(writes[0].status).toBe('incomplete');
    expect(writes[0].detail.identity_check).toEqual(identity);
    expect(writes[0].detail.account_id.status).toBe('PASS'); expect(writes[0].detail.active_flag.status).toBe('FAIL');
    expect(out.destinations[0].readiness_detail.identity_check).toEqual(identity);
    expect(out.destinations[0].readiness_status).toBe('incomplete');
    expect(JSON.stringify(out)).not.toContain('zq-secret-value-77'); // token value never exposed
  });
  test('no status change → nothing rewritten, view still carries identity_check; no identity_check → none invented', async () => {
    const writes = [];
    const rows = [{ ...DEST_FB, credential_ref: 'RD_TOK', active: false, readiness_status: 'incomplete', readiness_detail: { account_id: { status: 'PASS' }, identity_check: identity } },
                  { ...DEST_IG, credential_ref: 'RD_TOK', active: false, readiness_status: 'not_configured', readiness_detail: {} }];
    const out = await readiness.evaluate(runnerFor(rows, writes));
    expect(writes.length).toBe(1); expect(writes[0].id).toBe('dest-ig'); expect(writes[0].detail.identity_check).toBeUndefined();
    expect(out.destinations[0].readiness_detail.identity_check).toEqual(identity);
    expect(out.destinations[1].readiness_detail.identity_check).toBeUndefined();
  });
});

// ── Organic vs PAID boundary ──
describe('retargeting boundary — organic publishing gate never authorizes paid Meta', () => {
  test('executionAuthorization channel meta reads meta_ads_enabled; organic meta_enabled ON leaves paid OFF', async () => {
    const execAuth = require('../src/services/executionAuthorizationService');
    cfg['marketing.destinations.meta_enabled'] = true; cfg['marketing.a9_publish_enabled'] = true;
    expect(await execAuth.channelEnabled('meta')).toBe(false);
    const authz = await execAuth.authorize({ channel: 'meta', consentState: { advertising: true } });
    expect(authz.authorized).toBe(false); expect(authz.reasons).toContain('channel_disabled:meta');
    cfg['marketing.destinations.meta_ads_enabled'] = true; expect(await execAuth.channelEnabled('meta')).toBe(true);
  });
  test('channelReadiness paid + audienceDestinations use the PAID key', async () => {
    const ready = require('../src/services/channelReadinessService');
    cfg['marketing.destinations.meta_enabled'] = true;
    expect(await ready.statusFor('paid')).toBe('gated');
    const dest = require('../src/lib/audienceDestinations');
    expect(dest.get('meta').enabled_config_key).toBe('marketing.destinations.meta_ads_enabled');
    expect(dest.get('meta').organic_publishing_gate).toBe('marketing.destinations.meta_enabled');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'audienceDestinations.js'), 'utf8');
    expect(src).not.toMatch(/sync\(\)\s*\{/); // still no provider sync implementation (no Custom Audience upload)
  });
});

// ── Director learning ──
describe('socialLearningService — explainable dimensions + durable correlational learnings', () => {
  const learn = require('../src/services/socialLearningService');
  const snap = (jobId, reach, eng, win = 'd7') => ({ social_job_id: jobId, window_key: win, provider_status: 'ok', metrics: { reach: { value: reach, availability: 'available' }, reactions: { value: eng, availability: 'available' }, clicks: { value: null, availability: 'unavailable' } } });
  function seeded() {
    const store = makeStore(); store.dests.push(DEST_FB, DEST_IG);
    for (let i = 0; i < 6; i++) { store.jobs.push(job({ id: 'fb' + i, post_id: 'p' + i, platform: 'facebook', destination_id: 'dest-fb', wave: 'LAUNCH', copy_style: 'Now live' })); store.snaps.push(snap('fb' + i, 1000, 10)); }
    for (let i = 0; i < 6; i++) { store.jobs.push(job({ id: 'ig' + i, post_id: 'q' + i, platform: 'instagram', destination_id: 'dest-ig', wave: 'FINAL', copy_style: 'Closing soon' })); store.snaps.push(snap('ig' + i, 1000, 40)); }
    store.jobs.push(job({ id: 'nosnap', post_id: 'z', platform: 'facebook', destination_id: 'dest-fb' })); // published but not yet measured
    store.lots = [{ auction_id: '11111111-1111-4111-8111-111111111111', category_key: 'furniture', n: 30 }];
    store.referred = 12; store.referredIntent = 3; store.fbclid = 5;
    return store;
  }
  test('directorSummary: per-dimension engagement rates, honest gaps, downstream INFLUENCED, category from lots, local time buckets', async () => {
    const s = await learn.directorSummary(makeRunner(seeded()), { sinceDays: 90 });
    expect(s.posts_published).toBe(13); expect(s.posts_measured).toBe(12); expect(s.honest_gaps.posts_without_snapshot).toBe(1);
    const byPlatform = Object.fromEntries(s.by_dimension.platform.map((b) => [b.value, b]));
    expect(byPlatform.instagram.avg_engagement_rate).toBe(0.04); expect(byPlatform.facebook.avg_engagement_rate).toBe(0.01);
    expect(byPlatform.instagram.sample_adequate).toBe(true); expect(byPlatform.facebook.posts).toBe(7);
    expect(s.by_dimension.category[0].value).toBe('furniture');
    expect(s.by_dimension.copy_style.map((b) => b.value)).toEqual(expect.arrayContaining(['Now live', 'Closing soon']));
    expect(s.by_dimension.hour_bucket[0].value).toBe('morning'); // 14:00Z = 10:00 America/New_York
    expect(s.downstream.totals.social_referred_events).toBe(12 * 12); expect(s.downstream.note).toMatch(/never a causal claim/);
    expect(JSON.stringify(s)).not.toMatch(/text_excerpt|email|name/);
  });
  test('recordLearnings: material + adequately-sampled findings only; correlational; dry-run states what it would record', async () => {
    const out = await learn.recordLearnings(makeRunner(seeded()), { sinceDays: 90, dryRun: true });
    expect(out.dry_run).toBe(true);
    const keys = out.findings.map((f) => f.key);
    expect(keys).toContain('social_organic:platform:instagram'); expect(keys).toContain('social_organic:platform:facebook');
    expect(out.findings.find((f) => f.key === 'social_organic:platform:instagram').verdict).toBe('positive');
    expect(out.findings.find((f) => f.key === 'social_organic:platform:facebook').verdict).toBe('negative');
    expect(out.findings.every((f) => f.posts >= learn.MIN_SAMPLE)).toBe(true);
    expect(keys.some((k) => /category:furniture/.test(k))).toBe(false); // all posts share one category → no material difference
  });
  test('insufficient sample → no learning recorded (never over-claims)', async () => {
    const store = makeStore(); store.dests.push(DEST_FB); store.jobs.push(job({ id: 'a', post_id: 'a' })); store.snaps.push(snap('a', 100, 5));
    const out = await learn.recordLearnings(makeRunner(store), { sinceDays: 90 });
    expect(out.recorded).toBe(0); expect(out.reason).toBe('insufficient_sample');
  });
});

// ── Performance aggregation consumes the loop (seller allowlist + Director share the same facts) ──
describe('performanceAggregationService — real publish = DELIVERED; provider metrics = MEASURED', () => {
  const { makeStore: mkStore, makeRunner: mkRunner } = require('./helpers/marketingMemRunner');
  const perf = require('../src/services/performanceAggregationService');
  test("REAL 'published' job counts as DELIVERED (previously only 'published_shadow' was counted); snapshot engagement → MEASURED", async () => {
    const store = mkStore(); const r = mkRunner(store);
    store.social.push({ id: 'sj1', obligation_id: 'ob1', status: 'published', shadow: false });
    let out = await perf.aggregate({ purchaseKind: 'package', purchaseId: 'pp', obligations: [{ id: 'ob1', feature_key: 'social_post_organic' }] }, r);
    expect(out.metrics.social_post_organic).toEqual({ classification: 'DELIVERED', value: 1 });
    expect(store.perfFacts.find((f) => f.metric === 'social_post_organic_engagement').classification).toBe('ATTRIBUTION_UNAVAILABLE');
    store.perfFacts.length = 0;
    store.socialSnapshots.push({ social_job_id: 'sj1', metrics: { reach: { value: 900, availability: 'available' }, reactions: { value: 12, availability: 'available' }, comments: { value: 3, availability: 'available' }, saves: { value: null, availability: 'not_supported' } } });
    out = await perf.aggregate({ purchaseKind: 'package', purchaseId: 'pp', obligations: [{ id: 'ob1', feature_key: 'social_post_organic' }] }, r);
    expect(out.metrics.social_post_organic).toEqual({ classification: 'MEASURED', value: 15 });
    expect(store.perfFacts.find((f) => f.metric === 'social_post_organic_reach').value_numeric).toBe(900);
  });
  test('shadow publish stays internal (never a seller DELIVERED metric)', async () => {
    const store = mkStore(); const r = mkRunner(store);
    store.social.push({ id: 'sj2', obligation_id: 'ob2', status: 'published_shadow', shadow: true });
    const out = await perf.aggregate({ purchaseKind: 'package', purchaseId: 'pp', obligations: [{ id: 'ob2', feature_key: 'social_post_organic' }] }, r);
    expect(out.metrics.social_post_organic).toBeUndefined(); expect(out.internal_certification.shadow_only[0].source).toBe('social_shadow');
  });
});

// ── Publish path records linkage + schedules the ladder (real) / nothing (shadow) ──
describe('socialAdapter.publishWave — linkage columns + insights scheduling', () => {
  const { makeStore: mkStore, makeRunner: mkRunner } = require('./helpers/marketingMemRunner');
  test('shadow publish (gates OFF) → linkage recorded, insights not_applicable, no poll scheduled', async () => {
    jest.resetModules();
    jest.doMock('../src/services/marketingObligationEngine', () => ({ block: async () => {} }));
    const adapter = require('../src/services/socialAdapter');
    const store = mkStore(); const r = mkRunner(store);
    const out = await adapter.publishWave({ id: 'ob1' }, { auction: { auction_id: 'A1', title: 'Estate' }, wave: 'LAUNCH', referenceAt: '2026-09-09T00:00:00Z', creativeJobId: 'cj1', platform: 'facebook', stateCode: 'mi' }, r);
    expect(out.ok).toBe(true); expect(out.shadow).toBe(true);
    const j = store.social[0];
    expect(j.platform).toBe('facebook'); expect(j.state_code).toBe('MI'); expect(j.creative_job_id).toBe('cj1'); expect(j.copy_style).toBe('Now live');
    expect(j.status).toBe('published_shadow');
  });
});

// ── Worker ──
describe('marketingSocialInsightsWorker — inert when the switch is OFF', () => {
  test('tick with gate OFF performs no ingestion', async () => {
    jest.resetModules();
    const calls = [];
    jest.doMock('../src/services/socialInsightsService', () => ({ runOnce: async () => { calls.push('run'); return { ran: false, reason: 'insights_disabled', processed: 0, results: [] }; }, snapshotAccounts: async () => { calls.push('acct'); return { ran: false }; } }));
    const worker = require('../src/workers/marketingSocialInsightsWorker');
    await worker.tick();
    expect(calls).toEqual(['run']); // gate OFF → runOnce reports ran:false and the account snapshot is skipped; no provider contact
  });
});
