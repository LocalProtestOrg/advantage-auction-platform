'use strict';

/**
 * Meta full-funnel delivery chain.
 *
 * The properties that matter: every provider payload carries the fields Meta actually demands (each
 * one learned from a real rejection, not guessed), nothing can be created ACTIVE, only governed
 * inputs reach the provider, the excluded account is refused on every write path, and a retry
 * reconciles instead of duplicating.
 *
 * The chain itself is proven against the live account by scripts/certify-meta-chain.js, which
 * creates the minimum PAUSED artifacts, reads them back and deletes them.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readCode = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const readRaw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const meta = require('../src/services/paidGrowth/metaAdsProvider');
const delivery = require('../src/services/paidGrowth/metaDeliveryService');

// ── provider payloads: every field was learned from a real Meta rejection ─────────────────────

describe('the provider payloads carry what Meta actually requires', () => {
  test('campaign: budget-sharing flag and the $100 minimum spend cap', () => {
    const b = meta.buildCampaignBody({ name: 'x', funnel: 'individual_seller', spendCapCents: 13500 });
    expect(b.is_adset_budget_sharing_enabled).toBe(false);
    expect(b.status).toBe('PAUSED');
    expect(b.spend_cap).toBe(13500);
    expect(meta.buildCampaignBody({ name: 'x', funnel: 'buyer', spendCapCents: 5000 }).spend_cap).toBeUndefined();
  });

  test('ad set: a bid strategy is always set, or Meta demands a bid amount', () => {
    const b = meta.buildAdSetBody({ name: 'x', campaignId: '1', dailyBudgetCents: 5000,
      targetingSpec: { age_min: 25 }, pixelId: '2041842543203121' });
    expect(b.bid_strategy).toBe('LOWEST_COST_WITHOUT_CAP');
    expect(b.billing_event).toBe('IMPRESSIONS');
    expect(b.optimization_goal).toBe('OFFSITE_CONVERSIONS');
    expect(b.status).toBe('PAUSED');
    expect(b.daily_budget).toBe(5000);
  });

  test('ad set: geography and audience live here, never on the campaign', () => {
    const targeting = { geo_locations: { cities: [{ key: '2527622', radius: 25 }] }, age_min: 25 };
    const b = meta.buildAdSetBody({ name: 'x', campaignId: '1', dailyBudgetCents: 5000, targetingSpec: targeting });
    expect(b.targeting).toEqual(targeting);
    expect(meta.buildCampaignBody({ name: 'x', funnel: 'buyer', spendCapCents: 13500 }).targeting).toBeUndefined();
  });

  test('ad set: the conversion the campaign optimises toward is named', () => {
    const b = meta.buildAdSetBody({ name: 'x', campaignId: '1', dailyBudgetCents: 5000,
      targetingSpec: {}, pixelId: '2041842543203121' });
    expect(b.promoted_object).toEqual({ pixel_id: '2041842543203121', custom_event_type: 'COMPLETE_REGISTRATION' });
  });

  test('creative: image, words, destination, CTA and the Advantage.Bid page identity', () => {
    const b = meta.buildCreativeBody({ name: 'x', pageId: '449143945236360', instagramId: '17841436199617514',
      imageHash: 'abc', message: 'primary', headline: 'head', description: 'desc',
      destinationUrl: 'https://bid.advantage.bid/become-seller.html', ctaType: 'LEARN_MORE' });
    const ld = b.object_story_spec.link_data;
    expect(b.object_story_spec.page_id).toBe('449143945236360');
    expect(b.object_story_spec.instagram_user_id).toBe('17841436199617514');
    expect(ld.image_hash).toBe('abc');
    expect(ld.link).toBe('https://bid.advantage.bid/become-seller.html');
    expect(ld.call_to_action).toEqual({ type: 'LEARN_MORE', value: { link: 'https://bid.advantage.bid/become-seller.html' } });
  });

  test('creative: the deprecated standard-enhancements block is not sent', () => {
    const b = meta.buildCreativeBody({ name: 'x', pageId: '1', imageHash: 'a', message: 'm', headline: 'h',
      destinationUrl: 'https://bid.advantage.bid/' });
    expect(JSON.stringify(b)).not.toMatch(/standard_enhancements/);
    expect(readRaw('src/services/paidGrowth/metaAdsProvider.js')).toMatch(/DEPRECATED/);
  });

  test('creative: copy is trimmed to provider limits rather than rejected', () => {
    const b = meta.buildCreativeBody({ name: 'x', pageId: '1', imageHash: 'a',
      message: 'm'.repeat(5000), headline: 'h'.repeat(500), description: 'd'.repeat(500),
      destinationUrl: 'https://bid.advantage.bid/' });
    expect(b.object_story_spec.link_data.message.length).toBe(meta.COPY_LIMITS.primary_text);
    expect(b.object_story_spec.link_data.name.length).toBe(meta.COPY_LIMITS.headline);
    expect(b.object_story_spec.link_data.description.length).toBe(meta.COPY_LIMITS.description);
  });

  test('creative: an unknown call to action falls back to a supported one', () => {
    const b = meta.buildCreativeBody({ name: 'x', pageId: '1', imageHash: 'a', message: 'm', headline: 'h',
      destinationUrl: 'https://bid.advantage.bid/', ctaType: 'MAKE_IT_UP' });
    expect(meta.CTA_TYPES).toContain(b.object_story_spec.link_data.call_to_action.type);
  });

  test('ad: links an ad set to a creative and is created paused', () => {
    const b = meta.buildAdBody({ name: 'x', adsetId: '11', creativeId: '22' });
    expect(b).toEqual({ name: 'x', adset_id: '11', creative: { creative_id: '22' }, status: 'PAUSED' });
  });
});

// ── nothing can be created live ───────────────────────────────────────────────────────────────

describe('every provider object is created paused', () => {
  const code = readCode('src/services/paidGrowth/metaAdsProvider.js');

  test('no create path ever sends an ACTIVE status', () => {
    for (const fn of ['buildCampaignBody', 'buildAdSetBody', 'buildAdBody']) {
      const body = code.slice(code.indexOf('function ' + fn), code.indexOf('function ' + fn) + 900);
      expect(body).toMatch(/status: 'PAUSED'/);
      expect(body).not.toMatch(/status: 'ACTIVE'/);
    }
  });

  test('ACTIVE exists only as an explicit status transition', () => {
    const fn = code.slice(code.indexOf('async function setStatus'), code.indexOf('const pause'));
    expect(fn).toMatch(/\['PAUSED', 'ACTIVE', 'ARCHIVED'\]/);
    expect(fn).toMatch(/if \(!perms\.ads_management\) return/);
  });

  test('build mode is a real gate the runtime consults', () => {
    const d = readCode('src/services/paidGrowth/metaDeliveryService.js');
    expect(d).toMatch(/marketing\.paid\.build_mode/);
    const sql = readRaw('db/migrations/161_meta_full_funnel_execution.sql');
    expect(sql).toMatch(/'marketing\.paid\.build_mode', 'true'/);
    // The certification script refuses to run unless build mode is on.
    expect(readCode('scripts/certify-meta-chain.js')).toMatch(/REFUSE: build mode is off/);
  });

  test('provider objects record what they are ALLOWED to be, defaulting to PAUSED', () => {
    const sql = readRaw('db/migrations/161_meta_full_funnel_execution.sql');
    expect(sql).toMatch(/intended_status\s+text\s+NOT NULL DEFAULT 'PAUSED'/);
  });
});

// ── only governed inputs reach the provider ───────────────────────────────────────────────────

describe('only governed inputs reach the provider', () => {
  const d = readCode('src/services/paidGrowth/metaDeliveryService.js');

  test('an image is uploaded only when the registry says it is production-eligible', () => {
    const fn = d.slice(d.indexOf('async function ensureImage'), d.indexOf('async function rememberObject'));
    expect(fn).toMatch(/do-not-use assets are never uploaded/);
    expect(fn).toMatch(/production_eligible !== true/);
  });

  test('a file swapped on disk is not the approved asset', () => {
    const fn = d.slice(d.indexOf('async function ensureImage'), d.indexOf('async function rememberObject'));
    expect(fn).toMatch(/no longer matches the governed asset fingerprint/);
  });

  test('the same governed asset is uploaded once per account and then reused', () => {
    const fn = d.slice(d.indexOf('async function ensureImage'), d.indexOf('async function rememberObject'));
    expect(fn).toMatch(/reused: true/);
    const sql = readRaw('db/migrations/161_meta_full_funnel_execution.sql');
    expect(sql).toMatch(/UNIQUE \(provider, account_ref, asset_sha256\)/);
  });

  test('a creative package may only be active once the Owner approved it and policy is clean', () => {
    const sql = readRaw('db/migrations/161_meta_full_funnel_execution.sql');
    expect(sql).toMatch(/chk_mcp_active_requires_approval/);
    expect(sql).toMatch(/approval_state = 'OWNER_APPROVED' AND policy_status = 'OK'/);
  });

  test('a paid destination must be a canonical Advantage.Bid URL', () => {
    const sql = readRaw('db/migrations/161_meta_full_funnel_execution.sql');
    expect(sql).toMatch(/chk_mcp_destination/);
    expect(sql).toMatch(/destination_url LIKE 'https:\/\/bid\.advantage\.bid\/%'/);
  });

  test('changing a word changes the package fingerprint', () => {
    const base = { asset_sha256: 'a', primary_text: 'one', headline: 'h', description: null,
      cta_type: 'LEARN_MORE', destination_url: 'https://bid.advantage.bid/' };
    const a = delivery.packageFingerprint(base);
    const b = delivery.packageFingerprint(Object.assign({}, base, { primary_text: 'two' }));
    const c = delivery.packageFingerprint(Object.assign({}, base, { asset_sha256: 'b' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(delivery.packageFingerprint(base)).toBe(a);   // deterministic
  });

  test('the seeded copy makes no pricing, income or guarantee claim', () => {
    const seed = readRaw('scripts/seed-creative-packages.js');
    const copy = (seed.match(/primary_text:[\s\S]*?headline:/g) || []).join(' ');
    // A bare percentage is permitted: the Owner explicitly approved the 95-99% CLEANOUT service
    // proposition for estate-sale operators. What is forbidden is a percentage attached to fees or
    // pricing, which is what the seed guard actually tests for.
    expect(copy).not.toMatch(/\d+\s*%[^.]{0,40}(fee|fees|commission|premium|rate|pricing)/i);
    expect(copy).not.toMatch(/(fee|fees|commission|premium|rate|pricing)[^.]{0,40}\d+\s*%/i);
    expect(copy).not.toMatch(/buyer'?s? premium/i);
    expect(copy).not.toMatch(/guarantee/i);
    expect(copy).not.toMatch(/earn \$|make \$|up to \$/i);
    // And the guard that enforces it exists.
    expect(seed).toMatch(/const FORBIDDEN/);
    expect(seed).toMatch(/a percentage attached to fees or commission/);
  });
});

// ── attribution ───────────────────────────────────────────────────────────────────────────────

describe('every paid destination is attributable', () => {
  const url = delivery.buildDestination({
    destinationUrl: 'https://bid.advantage.bid/become-seller.html?seller_type=private',
    funnel: 'individual_seller', campaignKey: '2026-10-individual-seller-houston',
    strategyKey: 'IS-INTENT-HOU', experimentKey: 'EXP-IS-HOU-2026-10', armLabel: 'B-intent',
    packageKey: 'PKG-IS-HOU-V1' });
  const q = new URL(url).searchParams;

  test('provider, funnel, campaign, strategy, experiment and arm are all identifiable', () => {
    expect(q.get('utm_source')).toBe('meta');
    expect(q.get('utm_medium')).toBe('paid_social');
    expect(q.get('utm_campaign')).toBe('2026-10-individual-seller-houston');
    expect(q.get('utm_term')).toBe('IS-INTENT-HOU');
    expect(q.get('utm_content')).toBe('PKG-IS-HOU-V1');
    expect(q.get('adv_funnel')).toBe('individual_seller');
    expect(q.get('adv_experiment')).toBe('EXP-IS-HOU-2026-10');
    expect(q.get('adv_arm')).toBe('B-intent');
    expect(q.get('adv_provider')).toBe('meta');
  });

  test('the original destination and its own parameters survive', () => {
    expect(url.startsWith('https://bid.advantage.bid/become-seller.html')).toBe(true);
    expect(q.get('seller_type')).toBe('private');
  });

  test('the two seller funnels stay distinguishable', () => {
    const pro = new URL(delivery.buildDestination({
      destinationUrl: 'https://bid.advantage.bid/become-professional-seller.html',
      funnel: 'professional_seller', campaignKey: 'c', strategyKey: 's', experimentKey: 'e',
      armLabel: 'a', packageKey: 'p' })).searchParams;
    expect(pro.get('adv_funnel')).toBe('professional_seller');
    expect(q.get('adv_funnel')).not.toBe(pro.get('adv_funnel'));
  });

  test('it uses the existing UTM architecture rather than a competing one', () => {
    expect(q.get('utm_source')).toBeTruthy();
    expect(q.get('utm_medium')).toBeTruthy();
    expect(q.get('utm_campaign')).toBeTruthy();
  });
});

// ── isolation, idempotency, reconciliation, kill ──────────────────────────────────────────────

describe('safety across the whole chain', () => {
  const code = readCode('src/services/paidGrowth/metaAdsProvider.js');
  const d = readCode('src/services/paidGrowth/metaDeliveryService.js');

  test('every write path refuses an excluded ad account', () => {
    for (const fn of ['async function createCampaign', 'async function createAdSet',
      'async function createAdCreative', 'async function createAd', 'async function uploadImage',
      'async function validateObject', 'async function insights']) {
      const body = code.slice(code.indexOf(fn), code.indexOf(fn) + 700);
      expect(body).toMatch(/assertNotExcluded/);
    }
  });

  test('every write path requires ads_management', () => {
    for (const fn of ['async function createAdSet', 'async function createAdCreative',
      'async function createAd', 'async function uploadImage', 'async function deleteObject']) {
      const body = code.slice(code.indexOf(fn), code.indexOf(fn) + 700);
      expect(body).toMatch(/ads_management/);
    }
  });

  test('a retry reconciles instead of creating a second provider object', () => {
    const sql = readRaw('db/migrations/161_meta_full_funnel_execution.sql');
    expect(sql).toMatch(/idempotency_key\s+text\s+NOT NULL UNIQUE/);
    expect(d).toMatch(/ON CONFLICT \(idempotency_key\) DO UPDATE/);
    expect(d).toMatch(/async function findObject/);
  });

  test('reconciliation reports drift rather than silently repairing it', () => {
    const fn = d.slice(d.indexOf('async function reconcile'), d.indexOf('async function killAllDeliveryObjects'));
    expect(fn).toMatch(/drift/);
    expect(fn).toMatch(/present: false/);
  });

  test('the kill pauses ads before ad sets before campaigns, best effort, surfacing failures', () => {
    const fn = d.slice(d.indexOf('async function killAllDeliveryObjects'), d.indexOf('async function readPerformance'));
    expect(fn).toMatch(/\['ad', 'adset', 'campaign'\]/);
    expect(fn).toMatch(/\.catch\(/);
    expect(fn).toMatch(/failed: results\.filter/);
  });

  test('performance readback never invents a metric', () => {
    const fn = d.slice(d.indexOf('async function readPerformance'));
    expect(fn).toMatch(/x\.spend != null \? Math\.round\(Number\(x\.spend\) \* 100\) : null/);
    expect(fn).toMatch(/x\.impressions != null \? Number\(x\.impressions\) : null/);
  });

  test('certification artifacts are marked and cleaned up', () => {
    const sql = readRaw('db/migrations/161_meta_full_funnel_execution.sql');
    expect(sql).toMatch(/certification_artifact boolean\s+NOT NULL DEFAULT false/);
    const script = readCode('scripts/certify-meta-chain.js');
    expect(script).toMatch(/async function cleanup/);
    expect(script).toMatch(/deleteObject/);
  });

  test('credentials never leave the provider module', () => {
    const route = readCode('src/routes/adminMarketingAgency.js');
    expect(route).not.toMatch(/META_[A-Z_]*TOKEN/);
    expect(d).not.toMatch(/META_[A-Z_]*TOKEN/);
  });
});

// ── Owner visibility ──────────────────────────────────────────────────────────────────────────

describe('the Owner can inspect the whole hierarchy', () => {
  const page = readRaw('public/admin/marketing-agency.html');

  test('the delivery chain is presented in business order', () => {
    expect(page).toMatch(/Delivery chain/);
    for (const label of ['Package', 'Funnel', 'Image', 'Message', 'Headline', 'CTA', 'Destination', 'Approval']) {
      expect(page).toContain("'" + label + "'");
    }
    expect(page).toMatch(/Ad sets the experiments would create/);
    expect(page).toMatch(/Objects at Meta/);
  });

  test('build mode is shown so the Owner knows nothing can activate', () => {
    expect(page).toMatch(/BUILD MODE/);
    expect(page).toMatch(/can never be activated/);
  });

  test('provider ids are available for diagnostics', () => {
    expect(page).toContain("'Provider ID'");
    expect(page).toMatch(/certification artifact/);
  });

  test('the page uses no AI-facing vocabulary', () => {
    expect(page).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|machine learning|GPT|OpenAI/i);
  });
});
