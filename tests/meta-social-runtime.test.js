'use strict';

/**
 * Meta organic social runtime — multi-market registry + resolver + real Graph provider + autonomous dispatch
 * + readiness + credential masking. No network, no DB writes: DNS/HTTP/db/queue/config are injected or mocked.
 * All gates OFF; nothing publishes externally.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-social';

// ── destination resolver (fake runner over an in-memory destination set) ──
function runnerWith(dests) {
  return { query: async (sql, params = []) => {
    const s = String(sql);
    if (/scope='state'/.test(s)) {
      const [platform, st] = params;
      const rows = dests.filter((d) => d.platform === platform && d.scope === 'state' && d.state_code === st && d.active && d.readiness_status === 'ready');
      return { rows };
    }
    if (/scope='national'/.test(s)) {
      const [platform] = params;
      const rows = dests.filter((d) => d.platform === platform && d.scope === 'national' && d.active && d.readiness_status === 'ready');
      return { rows };
    }
    if (/FROM marketing_social_destinations ORDER BY/.test(s)) return { rows: dests };
    return { rows: [] };
  } };
}
const D = (o) => Object.assign({ id: o.id || (o.platform + '-' + o.scope + '-' + (o.state_code || 'nat')), platform: 'facebook', scope: 'national', state_code: null, active: true, readiness_status: 'ready', provider_account_id: '100', credential_ref: 'TEST_TOKEN', priority: 100 }, o);

describe('destination resolver — geographic fallback', () => {
  const svc = require('../src/services/socialDestinationService');
  const national = D({ id: 'nat-fb', scope: 'national', provider_account_id: 'PAGE_NAT' });
  const miFb = D({ id: 'mi-fb', scope: 'state', state_code: 'MI', provider_account_id: 'PAGE_MI' });

  test('state override when an active+ready state destination exists', async () => {
    const out = await svc.resolveDestination({ platform: 'facebook', stateCode: 'MI' }, runnerWith([national, miFb]));
    expect(out.reason).toBe('state_override'); expect(out.destination.provider_account_id).toBe('PAGE_MI');
  });
  test('national fallback when no state destination', async () => {
    const out = await svc.resolveDestination({ platform: 'facebook', stateCode: 'TX' }, runnerWith([national, miFb]));
    expect(out.reason).toBe('national_fallback'); expect(out.destination.provider_account_id).toBe('PAGE_NAT');
  });
  test('INACTIVE/unready state Page is skipped → national fallback (one broken market never blocks others)', async () => {
    const brokenMi = D({ id: 'mi-fb', scope: 'state', state_code: 'MI', readiness_status: 'error' });
    const out = await svc.resolveDestination({ platform: 'facebook', stateCode: 'MI' }, runnerWith([national, brokenMi]));
    expect(out.reason).toBe('national_fallback');
  });
  test('no valid destination → none (caller BLOCKS, never guesses)', async () => {
    const out = await svc.resolveDestination({ platform: 'facebook', stateCode: 'MI' }, runnerWith([]));
    expect(out.reason).toBe('none'); expect(out.destination).toBeNull();
  });
});

describe('credential masking (never expose a token)', () => {
  const svc = require('../src/services/socialDestinationService');
  test('toAdminView returns credential env NAME + presence boolean, never the token', () => {
    process.env.MASK_TOK = 'super-secret-token-value';
    const view = svc.toAdminView(D({ credential_ref: 'MASK_TOK', provider_account_id: 'PAGE' }));
    expect(view.credential_env_name).toBe('MASK_TOK');
    expect(view.credential_present).toBe(true);
    expect(JSON.stringify(view)).not.toContain('super-secret-token-value');
    delete process.env.MASK_TOK;
  });
});

describe('metaGraphProvider — request construction (injected HTTP; no network)', () => {
  const meta = require('../src/services/metaGraphProvider');
  const calls = [];
  const http = async (url, opts) => { calls.push({ url, opts });
    if (/\/media_publish/.test(url)) return { ok: true, status: 200, json: { id: 'IG_MEDIA_1' } };
    if (/\/media\b/.test(url)) return { ok: true, status: 200, json: { id: 'IG_CREATION_1' } };
    if (/fields=permalink/.test(url)) return { ok: true, status: 200, json: { permalink: 'https://instagram.com/p/abc' } };
    if (/\/photos/.test(url)) return { ok: true, status: 200, json: { id: 'FB_POST_1', post_id: 'FB_POST_1' } };
    if (/fields=access_token/.test(url)) return { ok: true, status: 200, json: { id: 'PAGE9', access_token: 'page-tok' } }; // Page token derivation (FB only)
    return { ok: true, status: 200, json: { id: 'X' } };
  };
  const copy = { headline: 'Now live', factual_manifest: [{ claim: 'title', value: 'Estate Sale' }], url: 'https://bid.advantage.bid/auction/A1' };
  beforeEach(() => { calls.length = 0; process.env.SU_TOKEN = 'tok'; });
  afterEach(() => { delete process.env.SU_TOKEN; });

  test('Facebook: POST /{page}/photos with public image url + caption + token', async () => {
    const p = meta.buildProvider({ platform: 'facebook', provider_account_id: 'PAGE9', credential_ref: 'SU_TOKEN' }, { http, version: 'v21.0' });
    expect(p.active).toBe(true);
    const r = await p.publish({ copy, image_url: 'https://cdn/x.jpg', reference_at: '2026-09-08' });
    expect(r.ok).toBe(true); expect(r.post_id).toBe('FB_POST_1'); expect(r.provider).toBe('facebook');
    // Page-scoped publish: the System User token is exchanged ONCE for the Page token (GET /{page}?fields=access_token,
    // never /me/accounts) and the photo is posted with the PAGE token.
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/PAGE9?fields=access_token&access_token=tok');
    expect(calls[1].url).toBe('https://graph.facebook.com/v21.0/PAGE9/photos');
    expect(calls[1].opts.body.url).toBe('https://cdn/x.jpg');
    expect(calls[1].opts.body.caption).toContain('https://bid.advantage.bid/auction/A1');
    expect(calls[1].opts.body.access_token).toBe('page-tok');
    expect(calls.some((c) => /\/me\/accounts/.test(c.url))).toBe(false);
  });
  test('Instagram: two-step media → media_publish → permalink', async () => {
    const p = meta.buildProvider({ platform: 'instagram', provider_account_id: 'IG9', credential_ref: 'SU_TOKEN' }, { http, version: 'v21.0' });
    const r = await p.publish({ copy, image_url: 'https://cdn/x.jpg' });
    expect(r.ok).toBe(true); expect(r.post_id).toBe('IG_MEDIA_1'); expect(r.permalink).toBe('https://instagram.com/p/abc');
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/IG9/media');
    expect(calls[1].url).toBe('https://graph.facebook.com/v21.0/IG9/media_publish');
    expect(calls[1].opts.body.creation_id).toBe('IG_CREATION_1');
  });
  test('Instagram requires a public image', async () => {
    const p = meta.buildProvider({ platform: 'instagram', provider_account_id: 'IG9', credential_ref: 'SU_TOKEN' }, { http });
    const r = await p.publish({ copy });
    expect(r.ok).toBe(false); expect(r.error).toBe('instagram_requires_public_image');
  });
  test('missing token → provider inactive (routes to resilience, never a false completion)', async () => {
    const p = meta.buildProvider({ platform: 'facebook', provider_account_id: 'PAGE9', credential_ref: 'ABSENT_ENV' }, { http });
    expect(p.active).toBe(false); expect(p.reason).toBe('missing_credential');
    const r = await p.publish({ copy, image_url: 'https://cdn/x.jpg' });
    expect(r.ok).toBe(false);
  });
});

describe('socialReadinessService — per-destination + gates', () => {
  const svc = require('../src/services/socialReadinessService');
  test('FB destination ready only when account_id + credential + active', () => {
    process.env.RS_TOK = 'x';
    expect(svc.evaluateDestination(D({ provider_account_id: 'P', credential_ref: 'RS_TOK', active: true })).status).toBe('ready');
    expect(svc.evaluateDestination(D({ provider_account_id: null, credential_ref: 'RS_TOK', active: true })).status).toMatch(/incomplete|not_configured/);
    expect(svc.evaluateDestination(D({ provider_account_id: 'P', credential_ref: 'RS_TOK', active: false })).status).toBe('incomplete');
    delete process.env.RS_TOK;
  });
  test('IG destination additionally requires a linked FB Page', () => {
    process.env.RS_TOK2 = 'x';
    const noLink = svc.evaluateDestination(D({ platform: 'instagram', provider_account_id: 'IG', credential_ref: 'RS_TOK2', active: true, linked_facebook_page_id: null }));
    expect(noLink.configured).toBe(false);
    const linked = svc.evaluateDestination(D({ platform: 'instagram', provider_account_id: 'IG', credential_ref: 'RS_TOK2', active: true, linked_facebook_page_id: 'PAGE' }));
    expect(linked.status).toBe('ready');
    delete process.env.RS_TOK2;
  });
});
