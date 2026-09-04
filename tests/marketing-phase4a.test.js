'use strict';

/**
 * Marketing Agency Phase 4A — intelligence runtime + A9/A2 proving ground. Pure-runtime coverage
 * (agents, Tier-3 language, QA severity + hooks, CTA, analytics allowlist), the A9→A2 proving loop
 * (draft-only), experiment authority, golden fixtures F1–F15, and additive-migration / no-duplicate guards.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

const agents = require('../src/constants/marketingAgents');
const brand = require('../src/lib/marketingBrandLanguage');
const qa = require('../src/services/marketingQaService');
const cta = require('../src/services/marketingCtaService');
const analytics = require('../src/services/marketingAnalyticsProfiles');

// ── A1–A14 registry + authority ─────────────────────────────────────────────────
describe('A1–A14 agent registry + authority', () => {
  test('all 14 agents exist with codes A1..A14', () => {
    for (let i = 1; i <= 14; i++) expect(agents.get('A' + i)).toBeTruthy();
  });
  test('creators cannot publish or spend; only A1/A8 spend; only A2 reviews; A6/A9 cannot publish (dormant)', () => {
    expect(agents.canSpend('A1')).toBe(true);
    expect(agents.canSpend('A8')).toBe(true);
    expect(agents.canSpend('A3')).toBe(false);
    expect(agents.canReview('A2')).toBe(true);
    expect(agents.canReview('A1')).toBe(false);
    ['A3', 'A4', 'A5', 'A6', 'A7', 'A9'].forEach((c) => expect(agents.canPublish(c)).toBe(false));
    expect(agents.agentCan('A9', 'draft_content')).toBe(true);
    expect(agents.agentCan('A9', 'growth_spend')).toBe(false);
  });
});

// ── Tier-3 brand language ────────────────────────────────────────────────────────
describe('Tier-3 fixed language + placeholder safety', () => {
  test('unfilled placeholder THROWS (never publishes a half-filled fee claim)', () => {
    expect(() => brand.render('professional_auction_fees', { platform_pct: '4%' })).toThrow(/placeholder/i);
  });
  test('professional fees render platform + processing SEPARATELY, never a combined commission', () => {
    const t = brand.render('professional_auction_fees', { platform_pct: '4%', processing_pct: '3%' });
    expect(t).toMatch(/4%/); expect(t).toMatch(/3%/);
    expect(t).toMatch(/not a single combined commission/i);
    expect(() => brand.assertNoBannedFeeClaim('A 7% Advantage.Bid commission applies')).toThrow();
  });
  test('individual = 0% + 3% + 18%; storefront = 11% inclusive', () => {
    expect(brand.render('individual_auction_fees', { processing_pct: '3%', buyer_premium_pct: '18%' })).toMatch(/no platform or seller fee \(0%\)/);
    expect(brand.render('storefront_fees', { storefront_pct: '11%' })).toMatch(/11%.*inclusive/i);
  });
});

// ── A2 QA runtime: severity, claim manifest, hooks, independence ─────────────────
describe('A2 QA runtime', () => {
  test('unsupported factual claim → S1 → return_to_producer (no release)', () => {
    const r = qa.reviewAsset({ asset: { text: 'Fine piece', producer_agent: 'A9' }, claims: [{ claim_kind: 'factual', claim_text: 'Made by Tiffany', authoritative_source: 'lot.maker', source_field: 'maker' }], sourceFields: {} });
    expect(r.severity).toBe('S1'); expect(r.disposition).toBe('return_to_producer'); expect(r.released).toBe(false);
  });
  test('supported factual claim → release_ready', () => {
    const r = qa.reviewAsset({ asset: { text: 'Solid oak table', producer_agent: 'A9' }, claims: [{ claim_kind: 'factual', claim_text: 'Oak', authoritative_source: 'lot.material', source_field: 'material' }], sourceFields: { material: 'oak' } });
    expect(r.disposition).toBe('release_ready'); expect(r.released).toBe(true);
  });
  test('independence: A2 cannot review an asset it authored → S4 block', () => {
    const r = qa.reviewAsset({ asset: { text: 'ok', producer_agent: 'A2' }, claims: [], sourceFields: {}, reviewer: 'A2' });
    expect(r.independent).toBe(false); expect(r.disposition).toBe('return_to_producer');
  });
  test('policy: AI terminology → S2; internal-economics leak → S4; both block', () => {
    expect(qa.detectPolicy('Powered by GPT').some((f) => f.severity === 'S2')).toBe(true);
    expect(qa.detectPolicy('funded from the Growth Pool').some((f) => f.severity === 'S4')).toBe(true);
  });
  test('implied-claim hooks fire (superlative, value anchoring, set implication)', () => {
    expect(qa.hooks.hookSuperlativeProximity('the finest example').length).toBe(1);
    expect(qa.hooks.hookValueAnchoring('worth $5,000').length).toBe(1);
    expect(qa.hooks.hookSetImplication('a complete set', { partial_set: true }).length).toBe(1);
    expect(qa.hooks.hookHeroSubstitution({ hero_item_id: 'x', item_ids: ['y'] }).length).toBe(1);
  });
});

// ── Full-Circle CTA clean-link ──────────────────────────────────────────────────
describe('CTA clean-link + route_verified', () => {
  test('dirty (AI/tracking) links are rejected', () => {
    expect(cta.isCleanLink('/search.html')).toBe(true);
    expect(cta.isCleanLink('/x?utm_source=chatgpt.com')).toBe(false);
    expect(cta.isCleanLink('/x?fbclid=abc')).toBe(false);
    expect(cta.isCleanLink('https://openai.com/x')).toBe(false);
  });
});

// ── Analytics allowlist ─────────────────────────────────────────────────────────
describe('analytics allowlist — no internal leak, missing ≠ 0', () => {
  test('only allowlisted present fields pass; forbidden internal fields dropped; missing omitted', () => {
    const src = { gross_revenue_cents: 5000, sold_lots: 3, direct_max_cents: 999, growth_pool_cents: 1, shortfall_cents: 42 };
    const out = analytics.applyAllowlist(src, ['gross_revenue_cents', 'sold_lots', 'unique_buyers_count', 'direct_max_cents']);
    expect(out).toEqual({ gross_revenue_cents: 5000, sold_lots: 3 }); // unique_buyers omitted (missing≠0); direct_max dropped (forbidden)
    expect(() => analytics.assertNoInternal(out)).not.toThrow();
    expect(() => analytics.assertNoInternal({ growth_pool_cents: 1 })).toThrow();
  });
});

// ── A9 proving loop (draft-only) ────────────────────────────────────────────────
describe('A9 → A2 proving loop (never publishes)', () => {
  let seo;
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/services/marketingConfigService', () => ({ a9PublishEnabled: async () => false, fullCircleRequired: async () => true }));
    jest.doMock('../src/services/marketingCtaService', () => ({ assignCtas: async () => ({ ok: true, disposition: 'full_circle', primary: { key: 'view_auction' } }) }));
    seo = require('../src/services/marketingSeoService');
  });
  afterEach(() => { jest.dontMock('../src/services/marketingConfigService'); jest.dontMock('../src/services/marketingCtaService'); });

  test('clean draft + passing QA → release_ready_draft, never published', async () => {
    const r = await seo.runProvingLoop({ topic: 'Estate auctions 101', producerAgent: 'A9', draftText: 'How online estate auctions work.', claims: [], sourceFields: {}, primaryCtaKey: 'view_auction' });
    expect(r.state).toBe('release_ready_draft');
    expect(r.published).toBe(false);
    expect(r.measurement.primary_metric).toBe('organic_sessions');
  });
  test('QA-blocked draft → returned_to_producer, never published', async () => {
    const r = await seo.runProvingLoop({ topic: 'x', producerAgent: 'A9', draftText: 'the finest one-of-a-kind piece, worth $9,999', claims: [{ claim_kind: 'factual', claim_text: 'By Fabergé', authoritative_source: 'lot.maker', source_field: 'maker' }], sourceFields: {}, primaryCtaKey: 'view_auction' });
    expect(r.state).toBe('returned_to_producer');
    expect(r.published).toBe(false);
  });
});

// ── Experiment authority ─────────────────────────────────────────────────────────
describe('experiment hypothesis contract + authority', () => {
  let exp, db;
  beforeEach(() => {
    jest.resetModules();
    db = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'e1' }] }) };
    jest.doMock('../src/db', () => db);
    exp = require('../src/services/marketingExperimentService');
  });
  afterEach(() => jest.dontMock('../src/db'));

  test('unfunded experiment by A9 is within authority (no Owner approval)', async () => {
    await exp.propose({ hypothesis: 'SEO on estate-sale keywords lifts organic sellers', proposedByAgent: 'A9' });
    const args = db.query.mock.calls[0][1];
    expect(args[args.length - 1]).toBe(true); // within_authority
  });
  test('funded experiment by A9 (cannot spend) → NOT within authority (needs Owner approval)', async () => {
    await exp.propose({ hypothesis: 'Paid test', proposedByAgent: 'A9', budgetCents: 50000 });
    expect(db.query.mock.calls[0][1].slice(-1)[0]).toBe(false);
  });
  test('funded experiment by A8 (spend-capable) → within authority', async () => {
    await exp.propose({ hypothesis: 'Paid local test', proposedByAgent: 'A8', budgetCents: 50000 });
    expect(db.query.mock.calls[0][1].slice(-1)[0]).toBe(true);
  });
  test('an agent without propose authority is rejected', async () => {
    await expect(exp.propose({ hypothesis: 'x', proposedByAgent: 'A4' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ── Golden fixtures F1–F15 (controlled; behavior-verified via the runtime) ───────
describe('golden marketing fixtures F1–F15', () => {
  const elig = require('../src/lib/marketingEligibility');
  test('F1 rich facts → supported claim releasable; F2 sparse/F3 unsupported maker → blocked', () => {
    expect(qa.reviewAsset({ asset: { text: 'Walnut dresser', producer_agent: 'A9' }, claims: [{ claim_kind: 'factual', claim_text: 'walnut', authoritative_source: 'lot.material', source_field: 'material' }], sourceFields: { material: 'walnut' } }).released).toBe(true);
    expect(qa.reviewAsset({ asset: { text: 'By a famous maker', producer_agent: 'A9' }, claims: [{ claim_kind: 'factual', claim_text: 'By Stickley', authoritative_source: 'lot.maker', source_field: 'maker' }], sourceFields: {} }).released).toBe(false);
  });
  test('F4 misleading collage (hero substitution) + F5 mixed-merch set implication → blocked', () => {
    expect(qa.reviewAsset({ asset: { text: 'featured', producer_agent: 'A9', hero_item_id: 'h', item_ids: ['a', 'b'] }, claims: [], sourceFields: {} }).released).toBe(false);
    expect(qa.reviewAsset({ asset: { text: 'a complete set of china', producer_agent: 'A9', partial_set: true }, claims: [], sourceFields: {} }).released).toBe(false);
  });
  test('F6 >50% apparel ineligible; F7 exactly 50% eligible; F8 T-48 boundary blocks purchase', () => {
    expect(elig.isClothingEligible(30, 16)).toBe(false);
    expect(elig.isClothingEligible(30, 15)).toBe(true);
    const close = Date.UTC(2026, 8, 20, 12, 0, 0);
    expect(elig.isWithinPurchaseWindow(close - 48 * 3600 * 1000, close)).toBe(false);
  });
  test('F14 seller-acquisition CTA is a secondary kind; F15 internal-economics leak is blocked by QA', () => {
    expect(qa.detectPolicy('see our internal marketing ledger').some((f) => f.severity === 'S4')).toBe(true);
    expect(brand.TEMPLATES.individual_seller_marketing).toMatch(/No seller fees charged from Advantage\.Bid/);
  });
});

// ── Migration 129: additive, no duplicates ──────────────────────────────────────
describe('migration 129 — additive runtime, no duplicate infra', () => {
  const mig = read('db', 'migrations', '129_marketing_agency_phase4a.sql');
  test('seeds A1–A14 with authority columns (extends marketing_agents, not a new table)', () => {
    expect(mig).toMatch(/ALTER TABLE marketing_agents ADD COLUMN IF NOT EXISTS code/);
    expect(mig).toMatch(/'A1'.*Marketing Director/);
    expect(mig).toMatch(/'A14'.*Analytics/);
  });
  test('adds experiments / ctas / social channels / deliverable evidence + QA severity columns', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS marketing_experiments/);
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS marketing_ctas/);
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS marketing_social_channels/);
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS marketing_deliverable_evidence/);
    expect(mig).toMatch(/ALTER TABLE marketing_qa_reviews ADD COLUMN IF NOT EXISTS severity/);
  });
  test('does NOT duplicate the certified queue/ledger/growth/settlement', () => {
    expect(mig).not.toMatch(/CREATE TABLE IF NOT EXISTS marketing_job_queue/);
    expect(mig).not.toMatch(/CREATE TABLE IF NOT EXISTS marketing_ledger/);
    expect(mig).not.toMatch(/CREATE TABLE IF NOT EXISTS growth_pool\b/);
    expect(mig).not.toMatch(/CREATE TABLE IF NOT EXISTS settlement_shortfalls/);
    expect(mig).not.toMatch(/pg-boss/i);
  });
  test('Facebook seeded pre_existing + authorization_required + agent publishing OFF', () => {
    expect(mig).toMatch(/advantage_bid_facebook.*facebook/);
    expect(mig).toMatch(/'pre_existing', 'authorization_required'/);
    expect(mig).toMatch(/agent_publish_enabled BOOLEAN NOT NULL DEFAULT false/);
  });
  test('Premium email promise retired in the OFFERING (forward), not rewriting purchases', () => {
    expect(mig).toMatch(/Dedicated Advantage\.Bid email campaign to eligible subscribers/);
    expect(mig).toMatch(/UPDATE marketing_packages/);
    expect(mig).not.toMatch(/UPDATE marketing_jobs SET/); // historical purchases untouched
  });
});

// ── Core closeout ────────────────────────────────────────────────────────────────
describe('core closeout: 7 nav pages migrated + X/30 focus refresh', () => {
  test('the 7 remaining Variant-A pages now use the shared public-nav widget', () => {
    ['how-sellers-get-paid', 'buyer-faq', 'seller-faq', 'shipping-available', 'downsizing-liquidation', 'after-estate-sale', 'seller-pilot'].forEach((f) => {
      const h = read('public', f + '.html');
      expect(h).toMatch(/data-adv-public-nav/);
      expect(h).toMatch(/widgets\/shared\/public-nav\.js/);
    });
  });
  test('lot-builder X/30 counter refreshes on focus (reflects mutations from other pages)', () => {
    expect(read('public', 'lot-builder.html')).toMatch(/addEventListener\('focus', function \(\) \{ if \(auctionId\) refreshProgress/);
  });
});
