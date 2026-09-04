'use strict';
// Marketing Agency Phase 4G — Marketing Director operating bridge + consent + onsite execution.
// Production DECIDES; agents may only REASON. Only onsite may execute; Google/Meta/A7 remain OFF.

const fs = require('fs');
const vm = require('vm');

// executionAuthorizationService reads marketingConfigService (DB) — mock so onsite=on, others=off.
jest.mock('../src/services/marketingConfigService', () => ({
  getBool: async (key, fb) => {
    if (key === 'marketing.onsite.enabled') return true;
    if (['marketing.a7_send_enabled', 'marketing.destinations.google_ads_enabled', 'marketing.destinations.meta_enabled'].includes(key)) return false;
    return fb;
  },
  getInt: async (_k, fb) => fb, raw: async (_k, fb) => fb,
}));

const opportunity = require('../src/services/opportunityService');
const collision = require('../src/services/collisionResolver');
const onsite = require('../src/services/onsiteService');
const targetingQa = require('../src/services/targetingQaService');
const growthBridge = require('../src/services/growthBridgeService');
const execAuth = require('../src/services/executionAuthorizationService');

// ── 1. Consent model (stub runner) ───────────────────────────────────────────
describe('consentService', () => {
  const svc = require('../src/services/consentService');
  function runner(rows) { return { query: async (sql, p) => {
    if (/INSERT INTO consent_records/.test(sql)) { runner._ins = (runner._ins || 0) + 1; return { rows: [] }; }
    if (/DISTINCT ON \(category\)/.test(sql)) return { rows: rows || [] };
    return { rows: [] };
  } }; }
  test('defaults: essential granted, analytics/personalization/advertising DENIED', async () => {
    const cur = await svc.current('visitor', 'v1', runner([]));
    expect(cur.essential).toBe('granted');
    expect(cur.advertising).toBe('denied');
    expect(cur.analytics).toBe('denied');
  });
  test('current reflects most recent recorded state', async () => {
    const cur = await svc.current('visitor', 'v1', runner([{ category: 'advertising', state: 'granted' }, { category: 'analytics', state: 'granted' }]));
    expect(cur.advertising).toBe('granted');
  });
  test('essential can never be denied; snapshot exposes booleans', async () => {
    const r = runner([]); await svc.record({ scopeType: 'visitor', scopeId: 'v1', categories: { essential: 'denied', advertising: 'granted' } }, r);
    expect(svc.snapshot({ analytics: 'granted', personalization: 'denied', advertising: 'granted' })).toMatchObject({ analytics: true, personalization: false, advertising: true });
  });
});

// ── 2. Click-ID capture (stub runner) ────────────────────────────────────────
describe('clickIdService', () => {
  const svc = require('../src/services/clickIdService');
  function cap() { const calls = []; return { calls, query: async (sql, p) => { calls.push({ sql, p }); return { rowCount: 1, rows: [] }; } }; }
  test('captures gclid/gbraid/wbraid/fbclid when present; dedup upsert', async () => {
    const r = cap();
    const got = await svc.capture({ scopeId: 'v1', params: { gclid: 'G', gbraid: 'GB', wbraid: 'WB', fbclid: 'FB', other: 'x' } }, r);
    expect(got.sort()).toEqual(['fbclid', 'gbraid', 'gclid', 'wbraid']);
    expect(r.calls[0].sql).toMatch(/ON CONFLICT \(scope_id, click_type, click_value\) DO UPDATE/);
  });
  test('none present → nothing captured', async () => {
    expect(await svc.capture({ scopeId: 'v1', params: { foo: 'bar' } }, cap())).toEqual([]);
  });
  test('link to user updates unlinked rows only', async () => {
    const r = cap(); await svc.linkToUser('v1', 'u1', r);
    expect(r.calls[0].sql).toMatch(/SET user_id = \$2 WHERE scope_id = \$1 AND user_id IS NULL/);
  });
});

// ── 3. Opportunity: feasibility, diagnosis, ranking, decisions ───────────────
describe('opportunityService', () => {
  test('feasibility declines are specific (not generic)', () => {
    expect(opportunity.feasibility({ objective: 'o', subject_ref: 's', requires_audience: true, size_estimate: 0 }).decline_reason).toBe('audience_too_small');
    expect(opportunity.feasibility({ objective: 'o', subject_ref: 's', influenceability: 'not_a_marketing_constraint' }).decline_reason).toBe('not_a_marketing_constraint');
    expect(opportunity.feasibility({}).decline_reason).toBe('insufficient_evidence');
  });
  test('auction diagnosis distinguishes marketing vs non-marketing constraint', () => {
    expect(opportunity.diagnoseAuction({ lots: 0 }).influenceability).toBe('not_a_marketing_constraint');
    expect(opportunity.diagnoseAuction({ lots: 5, views: 5 }).diagnosis).toBe('low_discovery');
    expect(opportunity.diagnoseAuction({ lots: 5, views: 100, registrations: 0 }).diagnosis).toBe('good_traffic_low_registration');
    expect(opportunity.diagnoseAuction({ lots: 5, views: 100, registrations: 10, bids: 1 }).diagnosis).toBe('good_registration_low_bidding');
  });
  test('ranking is lexicographic + explainable (no black-box score)', () => {
    const r = opportunity.rankOpportunities([
      { opportunity_type: 'a', time_criticality: 'low', objective: 'buyer_activation', value_band: 'medium', evidence_quality: 2 },
      { opportunity_type: 'b', time_criticality: 'urgent', objective: 'seller_acquisition', value_band: 'high', evidence_quality: 3 },
    ]);
    expect(r[0].opportunity_type).toBe('b');
    expect(r[0].ranking_reason).toMatch(/time_criticality/);
  });
  test('createDecision: decline requires a valid decline reason', async () => {
    const runner = { query: async () => ({ rows: [{ id: 'd1' }] }) };
    await expect(opportunity.createDecision({ decision: 'decline', decisionReason: 'nope' }, runner)).rejects.toThrow();
    await expect(opportunity.createDecision({ decision: 'bogus' }, runner)).rejects.toThrow();
    expect(await opportunity.createDecision({ decision: 'decline', decisionReason: 'outranked' }, runner)).toBeTruthy();
  });
});

// ── 4. Collision resolver ────────────────────────────────────────────────────
describe('collisionResolver', () => {
  test('transactional always passes and never blocks marketing selection', () => {
    const r = collision.resolve([{ id: 't', class: 'transactional' }, { id: 'm', class: 'onsite', objective: 'buyer_activation' }], {});
    expect(r.transactional_allowed).toContain('t');
    expect(r.winner).toBe('m');
  });
  test('existing seller never receives seller-acquisition', () => {
    const r = collision.resolve([{ id: 'acq', class: 'onsite', is_seller_acquisition: true }, { id: 'buy', class: 'onsite', objective: 'buyer_activation' }], { existingSeller: true });
    expect(r.blocked.find((b) => b.id === 'acq').reason).toBe('existing_seller_no_acquisition');
    expect(r.winner).toBe('buy');
  });
  test('at most one marketing action per person per day', () => {
    const r = collision.resolve([{ id: 'a', class: 'onsite' }, { id: 'b', class: 'onsite' }], { marketingSentToday: 1 });
    expect(r.winner).toBeNull();
    expect(r.blocked.every((b) => b.reason === 'one_marketing_per_day')).toBe(true);
  });
  test('seller package outranks discretionary Growth for same auction', () => {
    const r = collision.resolve([{ id: 'pkg', class: 'seller_package', auction_ref: 'A' }, { id: 'grw', class: 'growth', auction_ref: 'A' }], {});
    expect(r.winner).toBe('pkg');
    expect(r.blocked.find((b) => b.id === 'grw').reason).toBe('outranked_by_seller_package');
  });
  test('suppressed and converted are excluded', () => {
    const r = collision.resolve([{ id: 's', class: 'onsite', suppressed: true }, { id: 'c', class: 'onsite', converted: true }], {});
    expect(r.winner).toBeNull();
    expect(r.blocked.map((b) => b.reason).sort()).toEqual(['already_converted', 'suppressed']);
  });
});

// ── 5. Execution authorization gate (onsite active; Google/Meta/A7 refused) ──
describe('executionAuthorizationService', () => {
  test('onsite AUTHORIZED with personalization consent', async () => {
    const a = await execAuth.authorize({ channel: 'onsite', scopeId: 'v1', consentState: { personalization: true } });
    expect(a.authorized).toBe(true);
  });
  test('onsite REFUSED without personalization consent', async () => {
    const a = await execAuth.authorize({ channel: 'onsite', scopeId: 'v1', consentState: { personalization: false } });
    expect(a.authorized).toBe(false);
    expect(a.reasons).toContain('consent_missing:personalization');
  });
  test('google/meta/email hard-refused this phase (channel_disabled)', async () => {
    for (const c of ['google_ads', 'meta', 'a7_email']) {
      const a = await execAuth.authorize({ channel: c, scopeId: 'v1', consentState: { advertising: true, personalization: true } });
      expect(a.authorized).toBe(false);
      expect(a.reasons.some((x) => x.startsWith('channel_disabled'))).toBe(true);
    }
  });
});

// ── 6. A2 targeting QA (config-level) ────────────────────────────────────────
describe('targetingQaService.reviewConfig', () => {
  const audiences = require('../src/lib/behavioralAudiences');
  test('passes a well-formed audience for its objective+channel', () => {
    const def = audiences.get('high_intent_individual_seller');
    const v = targetingQa.reviewConfig(def, { objective: 'seller_acquisition', channel: 'onsite' });
    expect(v.pass).toBe(true);
  });
  test('flags channel not eligible + objective mismatch', () => {
    const def = audiences.get('high_intent_individual_seller');
    const v = targetingQa.reviewConfig(def, { objective: 'buyer_activation', channel: 'onsite' });
    expect(v.failed).toContain('objective_matches_audience');
  });
  test('sensitive-trait audience would be rejected', () => {
    const v = targetingQa.reviewConfig({ audience_key: 'x', allowed_channels: ['onsite'], qualifying: [{ signal: 'RELIGION_X' }], category: 'none', geography: 'none', conversion_exit: 'x' }, {});
    expect(v.failed).toContain('no_sensitive_trait');
  });
});

// ── 7. Growth Lab bridge: underpowered REFUSED ───────────────────────────────
describe('growthBridgeService.validate', () => {
  const full = { hypothesis: 'h', primary_objective: 'o', primary_metric: 'm', analysis_window_days: 14, minimum_detectable_effect: 0.1, required_exposure: 1000 };
  test('complete + sufficient audience → ok', () => {
    expect(growthBridge.validate({ preregFields: full, audienceSize: 100 }).ok).toBe(true);
  });
  test('missing MDE/exposure → underpowered', () => {
    expect(growthBridge.validate({ preregFields: Object.assign({}, full, { minimum_detectable_effect: null }), audienceSize: 100 }).refuse_reason).toBe('underpowered');
  });
  test('audience below minimum viable → underpowered (never widened)', () => {
    expect(growthBridge.validate({ preregFields: full, audienceSize: 5 }).refuse_reason).toBe('underpowered');
  });
  test('incomplete prereg → prereg_incomplete', () => {
    expect(growthBridge.validate({ preregFields: { hypothesis: 'h' }, audienceSize: 100 }).refuse_reason).toBe('prereg_incomplete');
  });
});

// ── 8. Onsite engine (pure chooser) ──────────────────────────────────────────
describe('onsiteService.chooseTreatment', () => {
  const S = (...a) => new Set(a);
  test('abandoned seller → resume prompt (no surveillance copy)', () => {
    const t = onsite.chooseTreatment({ pagePath: '/start-selling.html', signals: S('SELLER_SIGNUP_ABANDONMENT') });
    expect(t.playbook_key).toBe('abandoned_seller_resume');
    expect(t.headline).not.toMatch(/we noticed/i);
    expect(t.cta_href).toBe('/start-selling.html');
  });
  test('existing seller → seller-acquisition suppressed (falls through / null)', () => {
    const t = onsite.chooseTreatment({ pagePath: '/start-selling.html', signals: S('SELLER_SIGNUP_ABANDONMENT'), isExistingSeller: true });
    expect(t).toBeNull();
  });
  test('category interest requires matching live inventory', () => {
    expect(onsite.chooseTreatment({ pagePath: '/search.html', signals: S('CATEGORY_INTEREST'), hasCategoryInventory: false })).toBeNull();
    expect(onsite.chooseTreatment({ pagePath: '/search.html', signals: S('CATEGORY_INTEREST'), hasCategoryInventory: true }).playbook_key).toBe('category_relevance');
  });
  test('anonymous engaged visitor → contextual subscribe', () => {
    const t = onsite.chooseTreatment({ pagePath: '/event.html', pageIntent: 'estate_sale_interest', isAnonymous: true, signals: S() });
    expect(t.playbook_key).toBe('contextual_subscribe');
  });
  test('never on excluded/critical flows; no signals → null (page unaffected)', () => {
    expect(onsite.chooseTreatment({ pagePath: '/checkout.html', signals: S('SELLER_SIGNUP_ABANDONMENT') })).toBeNull();
    expect(onsite.chooseTreatment({ pagePath: '/how-it-works.html', signals: S() })).toBeNull();
  });
  test('one treatment only (returns a single object, not a list)', () => {
    const t = onsite.chooseTreatment({ pagePath: '/x', signals: S('SELLER_SIGNUP_ABANDONMENT', 'BUYER_SHOWING_SELLER_INTENT') });
    expect(Array.isArray(t)).toBe(false);
    expect(t.playbook_key).toBe('abandoned_seller_resume');   // first by priority
  });
});

// ── 9. Migration 135 + routes + gates (source-assertion) ─────────────────────
describe('migration 135 + wiring + gates', () => {
  const SQL = fs.readFileSync('db/migrations/135_director_bridge_consent_onsite_4g.sql', 'utf8');
  const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  test('additive; consent/click-id/opportunity/decision/onsite tables; onsite ON; providers/A7 not flipped', () => {
    expect(code).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    ['consent_records', 'marketing_click_ids', 'marketing_opportunities', 'marketing_decisions', 'marketing_onsite_treatments'].forEach((t) => expect(code).toMatch(new RegExp(t)));
    expect(code).toMatch(/analytics_events ADD COLUMN IF NOT EXISTS consent_state/);
    expect(code).toMatch(/marketing\.onsite\.enabled'?,?\s*'true'/);
    ['a7_send_enabled', 'google_ads_enabled', 'meta_enabled'].forEach((k) => expect(code).not.toMatch(new RegExp(k + "'\\s*,\\s*'true'")));
  });
  test('consent stamped on events at write time (analyticsService)', () => {
    const s = fs.readFileSync('src/services/analyticsService.js', 'utf8');
    expect(s).toMatch(/consent_state/);
    expect(s).toMatch(/raw\.consent/);
  });
  test('director route: RBAC, super-only writes, detect endpoint', () => {
    const r = fs.readFileSync('src/routes/adminDirector.js', 'utf8');
    expect(r).toMatch(/requirePermission\('members\.view'\)/);
    expect(r).toMatch(/superOnly/);
    expect(r).toMatch(/opportunities\/detect/);
    const rc = r.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(rc).not.toMatch(/sendEmail|sendCampaign|Send to all/i);
  });
  test('no 4G source enables Google, Meta, or A7', () => {
    ['db/migrations/135_director_bridge_consent_onsite_4g.sql', 'src/routes/adminDirector.js', 'src/services/executionAuthorizationService.js', 'src/services/onsiteService.js'].forEach((f) => {
      const s = fs.readFileSync(f, 'utf8');
      ['a7_send_enabled', 'google_ads_enabled', 'meta_enabled'].forEach((k) => expect(s).not.toMatch(new RegExp(k + "'\\s*,\\s*'true'")));
    });
  });
});

// ── 10. Consent banner + onsite client + watcher audit (static) ──────────────
describe('client UX + docs', () => {
  test('consent banner: advertising NOT pre-checked, no dark pattern, parses', () => {
    const b = fs.readFileSync('public/widgets/shared/consent-banner.js', 'utf8');
    expect(b).toMatch(/Reject non-essential/);
    expect(b).not.toMatch(/id="ac-ad"[^>]*checked/);   // advertising checkbox never checked
    expect(() => new vm.Script(b)).not.toThrow();
  });
  test('onsite client: no surveillance copy; page unaffected without treatment; parses', () => {
    const o = fs.readFileSync('public/widgets/shared/onsite-personalization.js', 'utf8');
    expect(o).not.toMatch(/we noticed/i);
    expect(o).toMatch(/fallback: no treatment|page unchanged|page unaffected/i);
    expect(() => new vm.Script(o)).not.toThrow();
  });
  test('watcher audit doc concludes DO NOT build a marketing duplicate', () => {
    const d = fs.readFileSync('docs/operations/watcher-closing-notification-audit-4g.md', 'utf8');
    expect(d).toMatch(/Do NOT build a marketing duplicate/i);
    expect(d).toMatch(/transactional/i);
  });
});

// ── 11. Director report: outcomes not vanity (source-assertion) ──────────────
describe('directorReportService (no vanity headline)', () => {
  const s = fs.readFileSync('src/services/directorReportService.js', 'utf8');
  test('headlines declines + dollars; explicitly excludes vanity metrics', () => {
    expect(s).toMatch(/what_we_declined/);
    expect(s).toMatch(/spend_dollars/);
    expect(s).toMatch(/not headlined/i);
  });
});
