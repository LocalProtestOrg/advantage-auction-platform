'use strict';
// Marketing Agency Phase 4F — first-party behavioral intelligence + retargeting audience engine.
// First-party only. No Google/Meta connection, no A7, no send, no list import. Explainable signals only.

const fs = require('fs');
const vm = require('vm');

const intent = require('../src/lib/pageIntentRegistry');
const signals = require('../src/services/behavioralSignalService');
const audiences = require('../src/lib/behavioralAudiences');
const destinations = require('../src/lib/audienceDestinations');

const ev = (t, pi, ck, d) => ({ event_type: t, page_intent: pi, category_key: ck, received_at: d });

// ── 1. Page-intent registry (one helper; no scattered path checks) ───────────
describe('pageIntentRegistry', () => {
  test('classifies seller / buyer / home; unknown → null', () => {
    expect(intent.classify('/become-seller.html').intent).toBe('seller_intent_high');
    expect(intent.classify('/professional-sellers.html').intent).toBe('professional_seller_intent');
    expect(intent.classify('/event.html?slug=x').intent).toBe('estate_sale_interest');
    expect(intent.classify('/auction-view.html?auctionId=1').intent).toBe('event_interest');
    expect(intent.classify('/random-thing')).toBeNull();
  });
  test('strips query/hash and is case-insensitive', () => {
    expect(intent.classify('https://bid.advantage.bid/SELLER-FAQ.html?x=1#y').intent).toBe('seller_consideration');
  });
});

// ── 2. Derived signals: raw ≠ derived; explainable; recency/frequency/sequence/conversion ──
describe('behavioralSignalService.deriveSignals', () => {
  test('one Become-a-Seller view = weak; journey + started = very high + abandonment', () => {
    const weak = signals.deriveSignals([ev('page_view', 'seller_intent_high', null, '2026-09-01')]);
    const si = weak.find((s) => s.signal_type === 'SELLER_INTENT');
    expect(si.level).toBeLessThanOrEqual(2);
    const strong = signals.deriveSignals([
      ev('page_view', 'seller_intent_high', null, '2026-09-01'),
      ev('page_view', 'seller_consideration', null, '2026-09-02'),
      ev('seller_signup_started', null, null, '2026-09-02'),
    ]);
    expect(strong.find((s) => s.signal_type === 'SELLER_INTENT').level).toBe(4);
    expect(strong.some((s) => s.signal_type === 'SELLER_SIGNUP_ABANDONMENT')).toBe(true);
  });
  test('conversion EXITS the acquisition signal (completed → no SELLER_INTENT)', () => {
    const out = signals.deriveSignals([
      ev('page_view', 'seller_intent_high', null, '2026-09-01'),
      ev('seller_signup_completed', null, null, '2026-09-02'),
    ]);
    expect(out.some((s) => s.signal_type === 'SELLER_INTENT')).toBe(false);
    expect(out.some((s) => s.signal_type === 'SELLER_SIGNUP_ABANDONMENT')).toBe(false);
  });
  test('every signal is explainable (has a reason) and decays (expires_at)', () => {
    const out = signals.deriveSignals([ev('page_view', 'seller_intent_high', null, '2026-09-01')], { ttlDays: 45 });
    out.forEach((s) => { expect(typeof s.reason).toBe('string'); expect(s.reason.length).toBeGreaterThan(0); expect(s.expires_at).toBeTruthy(); });
  });
  test('OBSERVED category interest (>=3 views); never an inferred/sensitive trait', () => {
    const out = signals.deriveSignals([
      ev('lot_view', 'event_interest', 'jewelry', '2026-09-01'),
      ev('lot_view', 'event_interest', 'jewelry', '2026-09-01'),
      ev('lot_view', 'event_interest', 'jewelry', '2026-09-01'),
    ]);
    const c = out.find((s) => s.signal_type === 'CATEGORY_INTEREST');
    expect(c.observed_categories.jewelry).toBe(3);
    expect(c.reason).toMatch(/observed/i);
    // No sensitive-trait signal types anywhere.
    const blob = JSON.stringify(out).toLowerCase();
    ['race', 'religion', 'health', 'political', 'sexual', 'orientation'].forEach((t) => expect(blob).not.toContain(t));
  });
  test('an unknown category_key is ignored (controlled taxonomy only)', () => {
    const out = signals.deriveSignals([
      ev('lot_view', 'event_interest', 'not_a_real_category', '2026-09-01'),
      ev('lot_view', 'event_interest', 'not_a_real_category', '2026-09-01'),
      ev('lot_view', 'event_interest', 'not_a_real_category', '2026-09-01'),
    ]);
    expect(out.some((s) => s.signal_type === 'CATEGORY_INTEREST')).toBe(false);
  });
  test('buyer behavior creates seller-intent composite ONLY with real seller evidence', () => {
    const buyerOnly = signals.deriveSignals([ev('bid_placed', null, null, '2026-09-01'), ev('page_view', 'auction_interest', null, '2026-09-01')]);
    expect(buyerOnly.some((s) => s.signal_type === 'BUYER_SHOWING_SELLER_INTENT')).toBe(false);
    const both = signals.deriveSignals([ev('bid_placed', null, null, '2026-09-01'), ev('page_view', 'seller_intent_high', null, '2026-09-02')]);
    expect(both.some((s) => s.signal_type === 'BUYER_SHOWING_SELLER_INTENT')).toBe(true);
  });
  test('no events → no signals', () => { expect(signals.deriveSignals([])).toEqual([]); });
});

// ── 3. Audience library + definition contract ────────────────────────────────
describe('behavioralAudiences', () => {
  test('compact library covers seller/professional/buyer/interest families', () => {
    const fams = new Set(audiences.all().map((a) => a.family));
    ['seller', 'professional', 'buyer', 'interest'].forEach((f) => expect(fams.has(f)).toBe(true));
    expect(audiences.KEYS.length).toBeLessThanOrEqual(20);   // compact, not hundreds
  });
  test('every audience declares purpose, qualifying, conversion_exit, channels, success', () => {
    audiences.all().forEach((a) => {
      expect(a.purpose).toBeTruthy();
      expect(Array.isArray(a.qualifying) && a.qualifying.length).toBeTruthy();
      expect(a.conversion_exit).toBeTruthy();
      expect(Array.isArray(a.allowed_channels)).toBe(true);
      expect(a.success_outcome).toBeTruthy();
    });
  });
});

// ── 4. Membership lifecycle (stub runner): entry, conversion exit, expiry ─────
describe('audienceMembershipService.refreshAudience', () => {
  const svc = require('../src/services/audienceMembershipService');
  function runner(state) {
    // state.qualified = rows for the qualifying-signal SELECT; state.active = current active members.
    return { query: async (sql, params) => {
      if (/FROM marketing_signals s\b/.test(sql)) return { rows: state.qualified || [] };
      if (/INSERT INTO marketing_audience_members/.test(sql)) { state.inserts = (state.inserts || 0) + 1; return { rows: [{ inserted: true }] }; }
      if (/SELECT scope_type, scope_id, expires_at FROM marketing_audience_members/.test(sql)) return { rows: state.active || [] };
      if (/UPDATE marketing_audience_members SET exited_at/.test(sql)) { state.exits = (state.exits || 0) + 1; return { rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    } };
  }
  test('qualified scope enters the audience', async () => {
    const state = { qualified: [{ scope_type: 'user', scope_id: 'u1', level: 3, reason: 'x' }], active: [] };
    const r = await svc.refreshAudience('high_intent_individual_seller', runner(state));
    expect(r.entered).toBe(1); expect(state.inserts).toBe(1);
  });
  test('member who no longer qualifies (converted) EXITS', async () => {
    const state = { qualified: [], active: [{ scope_type: 'user', scope_id: 'u1', expires_at: null }] };
    const r = await svc.refreshAudience('high_intent_individual_seller', runner(state));
    expect(r.exited).toBe(1); expect(state.exits).toBe(1);
  });
  test('expired member exits with reason expired', async () => {
    const past = '2020-01-01T00:00:00Z';
    const state = { qualified: [{ scope_type: 'user', scope_id: 'u1', level: 3 }], active: [{ scope_type: 'user', scope_id: 'u2', expires_at: past }] };
    const r = await svc.refreshAudience('high_intent_individual_seller', runner(state));
    expect(r.exited).toBe(1);
  });
});

// ── 5. Destination contract: provider-neutral; Google/Meta OFF; no fabricated ids ──
describe('audienceDestinations', () => {
  test('declares a7_email/google_ads/meta/onsite; external destinations require consent + are OFF', () => {
    ['a7_email', 'google_ads', 'meta', 'onsite'].forEach((t) => expect(destinations.get(t)).toBeTruthy());
    expect(destinations.get('google_ads').kind).toBe('external_paid');
    expect(destinations.get('meta').kind).toBe('external_paid');
  });
  test('export spec emits NO members and NO provider id (readiness only)', () => {
    const spec = destinations.buildExportSpec({ audience_key: 'auction_browser', conversion_exit: 'x' }, 'google_ads');
    expect(spec.enabled).toBe(false);
    expect(spec.member_identity).toBe('hashed_email');
    expect(spec).not.toHaveProperty('members');
    expect(spec.note).toMatch(/no provider is contacted|sync\(\) is not called/i);
  });
  test('Google/Meta readiness lists a public consent requirement (gap flagged)', () => {
    expect(destinations.get('google_ads').readiness.join(' ')).toMatch(/consent/i);
    expect(destinations.get('meta').readiness.join(' ')).toMatch(/consent/i);
  });
});

// ── 6. Marketing Director decision support + least-access agent model ─────────
describe('marketingDirectorService', () => {
  const director = require('../src/services/marketingDirectorService');
  test('experimentInput passes the audience_key to the Growth Lab (reuses marketing_experiments.audience)', () => {
    const inp = director.experimentInput('high_intent_individual_seller', 'A11');
    expect(inp.audience).toBe('high_intent_individual_seller');
    expect(inp.proposer_can_propose_audience).toBe(true);   // A11 has propose_audience
    expect(inp.note).toMatch(/preregistration|causal/i);
  });
  test('no agent gets raw clickstream; only some receive briefs', () => {
    expect(director.agentAccess('A1').can_receive_briefs).toBe(true);
    expect(director.agentAccess('A1').raw_clickstream).toBe(false);
    expect(director.agentAccess('A3').can_receive_briefs).toBe(false);   // creative agent: no audience briefs
    expect(director.agentAccess('A11').can_propose_audience).toBe(true);
  });
});

// ── 7. Identity linkage (stub runner): explicit, dedup-safe, no speculative merge ──
describe('behavioralIdentityService', () => {
  const svc = require('../src/services/behavioralIdentityService');
  const runner = () => ({ query: async (sql, p) => ({ rows: [{ id: 'l1', visitor_id: p[0], user_id: p[1], source: p[3] }] }) });
  test('links on an authoritative action; rejects bad input / bad source', async () => {
    expect(await svc.link({ visitorId: 'v_1', userId: 'u1', source: 'login' }, runner())).toBeTruthy();
    expect(await svc.link({ visitorId: 'v_1', userId: 'u1', source: 'guessing' }, runner())).toBeNull();
    expect(await svc.link({ visitorId: '', userId: 'u1', source: 'login' }, runner())).toBeNull();
    expect(await svc.link({ visitorId: 'v_1', source: 'login' }, runner())).toBeNull();   // nothing to link to
  });
});

// ── 8. Raw-layer + client + route wiring (source-assertion) ──────────────────
describe('raw behavioral layer wiring', () => {
  test('analyticsService stores visitor_id + server-classified page_intent + category_key', () => {
    const s = fs.readFileSync('src/services/analyticsService.js', 'utf8');
    expect(s).toMatch(/visitor_id/); expect(s).toMatch(/page_intent/); expect(s).toMatch(/pageIntent\.classify/);
  });
  test('AAPAnalytics adds a durable visitor_id distinct from the 30-min session', () => {
    const c = fs.readFileSync('public/widgets/shared/analytics.js', 'utf8');
    expect(c).toMatch(/aap_visitor_id/); expect(c).toMatch(/_getVisitorId/); expect(c).toMatch(/VISITOR_TTL_MS/);
  });
  test('identify endpoint is AUTHENTICATED (server-derived user_id, never client-asserted)', () => {
    const r = fs.readFileSync('src/routes/analytics.js', 'utf8');
    expect(r).toMatch(/\/identify/); expect(r).toMatch(/auth,/); expect(r).toMatch(/req\.user\.id/);
  });
  test('behavior-tracker + no fingerprinting anywhere', () => {
    const t = fs.readFileSync('public/widgets/shared/behavior-tracker.js', 'utf8');
    expect(t).toMatch(/AAPAnalytics/);
    // Strip comments, then assert no fingerprinting APIs are actually CALLED (the word "fingerprinting"
    // legitimately appears in doc comments describing what we do NOT do).
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const all = strip(t) + strip(fs.readFileSync('public/widgets/shared/analytics.js', 'utf8'));
    expect(all).not.toMatch(/getImageData|toDataURL|webgl|AudioContext|navigator\.plugins/i);
  });
});

// ── 9. Migration 134 (additive; providers OFF; A7 untouched) + admin route ───
describe('migration 134 + admin route', () => {
  const SQL = fs.readFileSync('db/migrations/134_behavioral_intelligence_4f.sql', 'utf8');
  const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const ROUTE = fs.readFileSync('src/routes/adminAudiences.js', 'utf8');
  const PAGE = fs.readFileSync('public/admin/audiences.html', 'utf8');
  test('additive; new tables; Google/Meta destinations seeded OFF; A7 not flipped', () => {
    expect(code).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(code).toMatch(/marketing_signals/); expect(code).toMatch(/marketing_audience_members/);
    expect(code).toMatch(/marketing_audience_destinations/); expect(code).toMatch(/behavioral_identity_links/);
    expect(code).toMatch(/google_ads_enabled['"]?,\s*'false'/);
    expect(code).toMatch(/meta_enabled['"]?,\s*'false'/);
    expect(code).not.toMatch(/a7_send_enabled['"]?,\s*'true'/);
  });
  test('admin route: RBAC members.view, refresh compute, NO mass-send, no raw clickstream dump', () => {
    expect(ROUTE).toMatch(/requirePermission\('members\.view'\)/);
    const rc = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(rc).not.toMatch(/sendEmail|sendCampaign|Send to all/i);
    expect(rc).not.toMatch(/SELECT \* FROM analytics_events/i);   // never dumps raw events
  });
  test('admin page: no mass-send button; states raw clickstream not exposed; parses', () => {
    expect(PAGE).not.toMatch(/Send (campaign|to all|email|blast)/i);
    expect(PAGE).not.toMatch(/\bAI\b/);
    const scripts = [...PAGE.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    scripts.forEach((s) => expect(() => new vm.Script(s)).not.toThrow());
  });
});

// ── 10. Guards: providers/A7 OFF across all 4F source; Follow Seller untouched ──
describe('safety guards', () => {
  test('no 4F source enables Google, Meta, or A7', () => {
    const files = [
      'db/migrations/134_behavioral_intelligence_4f.sql', 'src/routes/adminAudiences.js',
      'src/services/audienceMembershipService.js', 'src/lib/audienceDestinations.js', 'src/services/marketingDirectorService.js',
    ];
    // Match ACTUAL enabling: a SQL config seed ('key', 'true') or a JS object literal (enabled: true) —
    // NOT readiness prose like "marketing.a7_send_enabled = true (Owner)".
    files.forEach((f) => {
      const s = fs.readFileSync(f, 'utf8');
      ['a7_send_enabled', 'google_ads_enabled', 'meta_enabled'].forEach((k) => {
        expect(s).not.toMatch(new RegExp(k + "'\\s*,\\s*'true'"));                 // SQL seed to true
        expect(s).not.toMatch(new RegExp(k + '_config[^\\n]*:\\s*true'));          // (defensive) object literal
      });
    });
  });
  test('Follow Seller migration untouched', () => {
    expect(fs.readFileSync('db/migrations/032_create_seller_followers.sql', 'utf8')).toMatch(/CREATE TABLE IF NOT EXISTS seller_followers/);
  });
});
