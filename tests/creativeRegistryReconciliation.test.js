'use strict';

/**
 * Creative registry reconciliation.
 *
 * The property that matters: a production image the Owner drops into the folder must become VISIBLE
 * immediately — registered and reported — without becoming APPROVED. Presence is not authorization,
 * before or after this reconciliation. An unexplained file is a failure condition.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const readCode = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const readRaw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const registry = require('../src/services/productionCreativeRegistry');
const meta = require('../src/services/paidGrowth/metaAdsProvider');

// ── the folder as it actually is ──────────────────────────────────────────────────────────────

describe('the Professional Seller folder is fully enumerated from disk', () => {
  const scan = registry.scan();
  const ps = scan.assets.filter((a) => a.category === 'professional-seller');

  test('every image sits in the professional-seller category and none is foreign', () => {
    expect(ps.length).toBeGreaterThanOrEqual(5);
    expect(scan.foreign).toEqual([]);
    ps.forEach((a) => expect(a.relative_path.startsWith('professional-seller/')).toBe(true));
  });

  test('the Owner additions are present and are real images', () => {
    for (const f of ['estate-sale-company.png', 'estate-sale-company-operator.png', 'auction-house-operator.png']) {
      const a = ps.find((x) => x.filename === f);
      expect(a).toBeTruthy();
      expect(registry.isImage(a.filename)).toBe(true);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('the two estate-sale files are genuinely different images, not a duplicate', () => {
    const a = ps.find((x) => x.filename === 'estate-sale-company.png');
    const b = ps.find((x) => x.filename === 'estate-sale-company-operator.png');
    expect(a.sha256).not.toBe(b.sha256);
  });

  test('sidecar files are inventoried but are never advertising assets', () => {
    ps.forEach((a) => expect(a.filename).not.toMatch(/\.reference\.json$/));
    expect(scan.nonImages.some((p) => p.endsWith('.reference.json'))).toBe(true);
  });

  test('no Owner addition is a copy of the training library', () => {
    for (const f of ['estate-sale-company.png', 'estate-sale-company-operator.png', 'auction-house-operator.png']) {
      expect(ps.find((x) => x.filename === f).training_copy_of).toBeNull();
    }
  });

  test('nothing in the folder carries a blocking factual requirement', () => {
    ps.forEach((a) => expect(a.factual_requirements.blocking).toEqual([]));
  });
});

// ── presence is still not approval ────────────────────────────────────────────────────────────

describe('a new file becomes visible without becoming approved', () => {
  test('a freshly discovered image registers UNAPPROVED', () => {
    const code = readCode('src/services/productionCreativeRegistry.js');
    // Approval is only granted under the one-time grandfather flag, which is already spent.
    expect(code).toMatch(/if \(!existing && applyGrandfather && !isDoNotUse\)/);
    expect(code).toMatch(/awaiting explicit Owner approval for production/);
  });

  test('the Owner approval for this mission is an explicit, enumerated decision', () => {
    const seed = readRaw('scripts/seed-creative-packages.js');
    expect(seed).toMatch(/OWNER_APPROVED_ADDITIONS/);
    expect(seed).toMatch(/--approve-owner-additions/);
    expect(seed).toMatch(/approval_source = 'owner_review'/);
    // Approval still cannot override a blocking factual requirement.
    expect(seed).toMatch(/jsonb_array_length\(COALESCE\(factual_requirements->'blocking'/);
  });

  test('the blocked incorrect-logo duplicate is never resurrected', () => {
    const code = readCode('src/services/productionCreativeRegistry.js');
    expect(code).toMatch(/35ca7c7f593965530d32378d9f4285606fb9427c61a3a49a332818d2256a9b26/);
    const seed = readRaw('scripts/seed-creative-packages.js');
    expect(seed).not.toMatch(/individual-seller-turn-items-into-cash-gold-standard\.png\.png/);
  });

  test('do-not-use can never be approved by the approval path', () => {
    const seed = readRaw('scripts/seed-creative-packages.js');
    expect(seed).toMatch(/category <> 'do-not-use'/);
  });
});

// ── the reconciliation check itself ───────────────────────────────────────────────────────────

describe('filesystem vs registry vs Meta reconciliation', () => {
  const code = readCode('scripts/reconcile-creative-registry.js');

  test('it compares all three sources', () => {
    expect(code).toMatch(/marketing_production_creative/);
    expect(code).toMatch(/marketing_creative_packages/);
    expect(code).toMatch(/marketing_provider_images/);
    expect(code).toMatch(/registry\.scan\(\)/);
  });

  test('it reports every required count', () => {
    for (const k of ['filesystem', 'registered', 'eligible', 'blocked', 'meta_uploaded', 'unexplained']) {
      expect(code).toMatch(new RegExp(k + ':'));
    }
  });

  test('an unregistered file is unexplained and fails the check', () => {
    expect(code).toMatch(/unexplained: !rec/);
    expect(code).toMatch(/process\.exit\(counts\.unexplained \? 1 : 0\)/);
  });

  test('it detects a duplicate by content hash rather than filename', () => {
    expect(code).toMatch(/byHash\.get\(a\.sha256\)/);
    expect(code).toMatch(/duplicate_of/);
  });

  test('it never approves anything it discovers', () => {
    expect(code).not.toMatch(/owner_approved_for_production\s*=\s*true/);
    expect(code).not.toMatch(/UPDATE marketing_production_creative/);
    expect(readRaw('scripts/reconcile-creative-registry.js')).toMatch(/This never approves anything/);
  });
});

// ── specialised purpose metadata ──────────────────────────────────────────────────────────────

describe('specialised operators stay distinct inside the Professional Seller funnel', () => {
  const seed = readRaw('scripts/seed-creative-packages.js');

  test('estate sale company and auction house have their own audience purposes', () => {
    expect(seed).toMatch(/audience_purpose: 'estate_sale_company_acquisition'/);
    expect(seed).toMatch(/audience_purpose: 'auction_house_acquisition'/);
    expect(seed).toMatch(/audience_purpose: 'professional_seller_acquisition_general'/);
  });

  test('all of them remain in the one Professional Seller funnel', () => {
    const blocks = seed.split('package_key:').slice(1);
    const ps = blocks.filter((b) => /professional-seller|estate-sale-company|auction-house/.test(b));
    ps.forEach((b) => expect(b).toMatch(/funnel: 'professional_seller'/));
  });

  test('the general creative is preserved, not replaced by the specialised ads', () => {
    expect(seed).toMatch(/PKG-PS-HOU-V1/);
    expect(seed).toMatch(/PKG-PS-INVENTORY-V1/);
    expect(seed).toMatch(/PKG-PS-ESTATE-V1/);
    expect(seed).toMatch(/PKG-PS-ESTATE-OPERATOR-V1/);
    expect(seed).toMatch(/PKG-PS-AUCTIONHOUSE-V1/);
  });

  test('the estate and auction-house messages are not collapsed into one generic text', () => {
    const estate = seed.slice(seed.indexOf("PKG-PS-ESTATE-V1"), seed.indexOf("PKG-PS-ESTATE-OPERATOR-V1"));
    const auction = seed.slice(seed.indexOf("PKG-PS-AUCTIONHOUSE-V1"));
    expect(estate).toMatch(/cleanout/i);
    expect(auction).toMatch(/consignments/i);
    expect(estate).not.toMatch(/consignments/i);
  });
});

// ── governed copy ─────────────────────────────────────────────────────────────────────────────

describe('governed copy for the Professional Seller portfolio', () => {
  const seed = readRaw('scripts/seed-creative-packages.js');
  const copy = (seed.match(/primary_text:[\s\S]*?destination_url:/g) || []).join(' ');

  test('every Professional Seller destination is the canonical one', () => {
    const count = (seed.match(/https:\/\/bid\.advantage\.bid\/become-professional-seller\.html/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('the cleanout proposition is allowed, a fee percentage is not', () => {
    expect(copy).toMatch(/95–99% cleanout/);
    // The guard blocks a percentage attached to pricing words, not a bare percentage.
    expect(seed).toMatch(/a percentage attached to fees or commission/);
    expect(copy).not.toMatch(/\d+\s*%[^.]{0,40}\b(fee|commission|premium)\b/i);
  });

  test('no guarantee, income claim, buyer premium or sensitive assumption', () => {
    expect(copy).not.toMatch(/guarantee/i);
    expect(copy).not.toMatch(/buyer'?s? premium/i);
    expect(copy).not.toMatch(/earn \$|make \$|up to \$/i);
    expect(copy).not.toMatch(/divorc|widow|bereave|foreclos|bankrupt|deceased/i);
  });

  test('the Individual Seller comparative claim was removed and the rest preserved', () => {
    // Read CODE, not the comment that documents the removal.
    const code = readCode('scripts/seed-creative-packages.js');
    const is = code.slice(code.indexOf('PKG-IS-HOU-V1'), code.indexOf('PKG-PS-HOU-V1'));
    expect(is).not.toMatch(/keep more of the proceeds/i);
    expect(is).toMatch(/online auction/i);
    expect(is).toMatch(/reach real buyers/i);
    expect(is).toMatch(/No auction experience needed/i);
    expect(is).toMatch(/real people are here to help/i);
  });

  test('copy complements the image rather than repeating a whole headline block', () => {
    // Each package has its own distinct primary text.
    const texts = (seed.match(/primary_text: '([^']|'\s*\+\s*')+/g) || []);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

// ── provider constraints learned from Meta ────────────────────────────────────────────────────

describe('call-to-action values are the ones Meta actually accepts', () => {
  test('GET_STARTED, APPLY_NOW and SUBSCRIBE are not offered — Meta refused them', () => {
    expect(meta.CTA_TYPES).not.toContain('GET_STARTED');
    expect(meta.CTA_TYPES).not.toContain('APPLY_NOW');
    expect(meta.CTA_TYPES).not.toContain('SUBSCRIBE');
    expect(readRaw('src/services/paidGrowth/metaAdsProvider.js')).toMatch(/taken from its own rejection message/);
  });

  test('the accepted values are offered and an unknown one falls back safely', () => {
    for (const c of ['LEARN_MORE', 'SIGN_UP', 'CONTACT_US', 'SEE_DETAILS', 'SHOP_NOW']) {
      expect(meta.CTA_TYPES).toContain(c);
    }
    const b = meta.buildCreativeBody({ name: 'x', pageId: '1', imageHash: 'a', message: 'm', headline: 'h',
      destinationUrl: 'https://bid.advantage.bid/', ctaType: 'GET_STARTED' });
    expect(b.object_story_spec.link_data.call_to_action.type).toBe('LEARN_MORE');
  });

  test('every seeded CTA is one Meta accepts', () => {
    const seed = readRaw('scripts/seed-creative-packages.js');
    const ctas = (seed.match(/cta_type: '([A-Z_]+)'/g) || []).map((m) => m.split("'")[1]);
    expect(ctas.length).toBeGreaterThanOrEqual(6);
    ctas.forEach((c) => expect(meta.CTA_TYPES).toContain(c));
  });
});

// ── budget is not multiplied by adding creative ───────────────────────────────────────────────

describe('more creative variants never multiply the authorised budget', () => {
  test('experiment arms are still checked against the campaign budget', () => {
    const ai = readCode('src/services/paidGrowth/audienceIntelligenceService.js');
    const fn = ai.slice(ai.indexOf('async function planExperiment'), ai.indexOf('async function assessArm'));
    expect(fn).toMatch(/if \(total > Number\(c\.budget_cents\)\)/);
    expect(fn).toMatch(/it never adds to it/);
  });

  test('no ceiling was changed by this mission', () => {
    for (const f of ['scripts/seed-creative-packages.js', 'scripts/reconcile-creative-registry.js',
      'scripts/certify-meta-chain.js']) {
      const src = readRaw(f);
      expect(src).not.toMatch(/monthly_ceiling_usd|campaign_ceiling_usd|daily_ceiling_usd/);
    }
  });

  test('a creative package carries no budget of its own', () => {
    const sql = readRaw('db/migrations/161_meta_full_funnel_execution.sql');
    const block = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS marketing_creative_packages'),
      sql.indexOf('CREATE INDEX IF NOT EXISTS idx_mcp_funnel'));
    expect(block).not.toMatch(/budget|cents/);
  });
});

// ── certification safety ──────────────────────────────────────────────────────────────────────

describe('certification never delivers', () => {
  const script = readCode('scripts/certify-meta-chain.js');

  test('it refuses to run unless build mode is on', () => {
    expect(script).toMatch(/REFUSE: build mode is off/);
  });

  test('it creates paused artifacts and deletes them', () => {
    expect(script).toMatch(/async function cleanup/);
    expect(script).toMatch(/deleteObject/);
    expect(script).not.toMatch(/setStatus\(\{[^}]*ACTIVE/);
  });

  test('it only uses Owner-approved, policy-clean packages', () => {
    expect(script).toMatch(/approval_state='OWNER_APPROVED' AND p\.policy_status='OK'/);
  });

  test('it only uses a provider-validated audience strategy', () => {
    expect(script).toMatch(/validation_state='VALID' AND policy_status='OK'/);
  });

  test('uploaded images may remain because they are inert', () => {
    expect(readRaw('scripts/certify-meta-chain.js')).toMatch(/Governed uploaded images|inert/i);
  });
});
