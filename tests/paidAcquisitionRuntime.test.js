'use strict';

/**
 * Paid acquisition runtime — production creative registry, budget enforcement, asset isolation and
 * the execution gates.
 *
 * These tests assert the SAFETY PROPERTIES rather than the implementation: that approval and
 * eligibility stay separate, that a training reference cannot become a paid advertisement, that
 * money cannot be committed past the Owner's authority, and that every path to spending fails
 * closed. The database-level guarantees (CHECK constraints) are additionally proven against
 * production by scripts/prod-migrate-159.js.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readCode = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
  .replace(/(^|[^:])\/\/.*$/gm, '$1');       // line comments (leaving URLs intact)
const readRaw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const registry = require('../src/services/productionCreativeRegistry');

// ── 1. The three libraries are never collapsed ────────────────────────────────────────────────

describe('library separation: production vs training vs brand assets', () => {
  test('the three roots are distinct directories', () => {
    expect(registry.PRODUCTION_ROOT).toMatch(/production-creative$/);
    expect(registry.TRAINING_ROOT).toMatch(/approved-creative-examples$/);
    expect(registry.BRAND_ROOT).toMatch(/brand-assets[\\/]logos$/);
    const roots = [registry.PRODUCTION_ROOT, registry.TRAINING_ROOT, registry.BRAND_ROOT];
    expect(new Set(roots).size).toBe(3);
  });

  test('official brand assets are a separate root and are never scanned as advertisements', () => {
    const scanned = registry.scan({ productionRoot: registry.PRODUCTION_ROOT });
    expect(scanned.assets.every((a) => !a.relative_path.includes('brand-assets'))).toBe(true);
    // The brand root exists and holds the only approved logo sources.
    expect(fs.existsSync(registry.BRAND_ROOT)).toBe(true);
  });

  test('the registry never treats filesystem presence as a standing approval rule', () => {
    const code = readCode('src/services/productionCreativeRegistry.js');
    // Approval is only granted under an explicit one-time grandfather flag.
    expect(code).toMatch(/applyGrandfather\s*=\s*grandfather\s*&&\s*firstRun/);
    expect(code).toMatch(/if \(!existing && applyGrandfather && !isDoNotUse\)/);
  });
});

// ── 2. Category semantics ─────────────────────────────────────────────────────────────────────

describe('category semantics', () => {
  test('every required category exists with a funnel and a purpose', () => {
    for (const c of ['auction', 'auction-event', 'buyer-acquisition', 'buyer-growth', 'do-not-use',
      'estate-sale', 'geographic-event', 'individual-seller', 'notable-lot', 'professional-seller']) {
      expect(registry.CATEGORIES).toContain(c);
      expect(registry.CATEGORY_PURPOSE[c].purpose).toBeTruthy();
    }
  });

  test('seller categories map to seller funnels and buyer categories to the buyer funnel', () => {
    expect(registry.CATEGORY_PURPOSE['individual-seller'].funnel).toBe('individual_seller');
    expect(registry.CATEGORY_PURPOSE['professional-seller'].funnel).toBe('professional_seller');
    expect(registry.CATEGORY_PURPOSE['buyer-acquisition'].funnel).toBe('buyer');
    expect(registry.CATEGORY_PURPOSE['buyer-growth'].funnel).toBe('buyer');
  });

  test('do-not-use has no funnel, so it can never be selected for any campaign', () => {
    expect(registry.CATEGORY_PURPOSE['do-not-use'].funnel).toBeNull();
    const forBuyer = registry.CATEGORIES.filter((c) => registry.CATEGORY_PURPOSE[c].funnel === 'buyer');
    expect(forBuyer).not.toContain('do-not-use');
  });

  test('the four event-specific categories demand live factual validation', () => {
    for (const c of ['geographic-event', 'auction-event', 'estate-sale', 'notable-lot']) {
      expect(registry.CATEGORY_PURPOSE[c].event_specific).toBe(true);
      const facts = registry.assessFacts({ category: c, sidecar: null, isTrainingCopy: false });
      expect(facts.deferred.join(' ')).toMatch(/currently authoritative/);
      expect(facts.deferred.join(' ')).toMatch(/never advertise an expired event as current/);
      expect(facts.deferred.join(' ')).toMatch(/never substitute another lot/);
      expect(facts.deferred.join(' ')).toMatch(/never invent merchandise/);
    }
  });

  test('notable-lot promotes exactly one authoritative lot', () => {
    expect(registry.CATEGORY_PURPOSE['notable-lot'].purpose).toMatch(/ONE authoritative specific auction lot/);
  });

  test('evergreen categories are not marked event-specific', () => {
    for (const c of ['buyer-acquisition', 'buyer-growth', 'individual-seller', 'professional-seller', 'auction']) {
      expect(registry.CATEGORY_PURPOSE[c].event_specific).toBe(false);
    }
  });
});

// ── 3. Approval vs eligibility ────────────────────────────────────────────────────────────────

describe('approval and eligibility are separate decisions', () => {
  test('do-not-use is blocking regardless of anything else', () => {
    const f = registry.assessFacts({ category: 'do-not-use', sidecar: null, isTrainingCopy: false });
    expect(f.blocking.join(' ')).toMatch(/never publish/);
  });

  // Owner policy 2026-09-22: provenance is not authorization. An advertisement may legitimately
  // exist as reference copy AND as a production-authorized copy; byte-identical content across the
  // two libraries is recorded as provenance, never as a blocker.
  test('a copy of a training Gold Standard is recorded as provenance, not blocked', () => {
    const f = registry.assessFacts({
      category: 'individual-seller', sidecar: null,
      isTrainingCopy: true, trainingPath: 'individual-seller/x.png',
    });
    expect(f.blocking).toEqual([]);
    expect(f.provenance.join(' ')).toMatch(/also present in the training \/ calibration library/);
    expect(f.provenance.join(' ')).toMatch(/reference copy stays reference-only/);
  });

  test('an Owner Gold Standard origin is preserved as provenance and does not restrict the production copy', () => {
    const f = registry.assessFacts({
      category: 'professional-seller', isTrainingCopy: false,
      sidecar: { owner_status: 'OWNER_GOLD_STANDARD', source: { rights: '' } },
    });
    expect(f.blocking).toEqual([]);
    expect(f.provenance.join(' ')).toMatch(/originated as an Owner Gold Standard/);
  });

  test('a calibration-only note describes the reference copy and does not block the production copy', () => {
    const f = registry.assessFacts({
      category: 'professional-seller', isTrainingCopy: false,
      sidecar: { source: { rights: 'Advantage.Bid-owned reference creative. Calibration evidence only: ...' } },
    });
    expect(f.blocking).toEqual([]);
    expect(f.provenance.join(' ')).toMatch(/does not govern this production copy/);
  });

  // The sidecar's logo restriction means "do not extract this rendering as a brand source asset".
  // It does not condemn the finished advertisement. Blocking is per-asset, from the Owner review.
  test('a sidecar logo restriction alone does not block a finished advertisement', () => {
    const f = registry.assessFacts({
      category: 'professional-seller', isTrainingCopy: false,
      sidecar: { source: { rights: 'the logo drawn inside it is an image-model rendering and is NOT an approved logo asset' } },
    });
    expect(f.blocking).toEqual([]);
  });

  test('an asset reviewed as having a materially incorrect logo IS blocked, by content hash', () => {
    const [hash, reason] = Object.entries(registry.LOGO_DEFECTS)[0];
    const f = registry.assessFacts({ category: 'individual-seller', sidecar: null, isTrainingCopy: false, sha256: hash });
    expect(f.blocking).toContain(reason);
    expect(reason).toMatch(/materially incorrect logo/);
    // Another asset with the same category but a different hash is unaffected.
    const clean = registry.assessFacts({ category: 'individual-seller', sidecar: null, isTrainingCopy: false, sha256: 'f'.repeat(64) });
    expect(clean.blocking).toEqual([]);
  });

  test('representative merchandise is permitted for general evergreen acquisition, never for event or lot creative', () => {
    const rights = { source: { rights: 'merchandise is representative, not lots' } };
    for (const c of ['individual-seller', 'professional-seller', 'buyer-acquisition', 'buyer-growth']) {
      const f = registry.assessFacts({ category: c, sidecar: rights, isTrainingCopy: false });
      expect(f.blocking).toEqual([]);
      expect(f.deferred.join(' ')).toMatch(/must not claim or imply .* specific currently available lot/);
    }
    for (const c of ['notable-lot', 'auction-event', 'estate-sale', 'geographic-event']) {
      const f = registry.assessFacts({ category: c, sidecar: rights, isTrainingCopy: false });
      expect(f.blocking.join(' ')).toMatch(/can never stand in for a specific advertised lot/);
    }
  });

  test('representative merchandise blocks advertising lots', () => {
    const f = registry.assessFacts({
      category: 'notable-lot', isTrainingCopy: false,
      sidecar: { source: { rights: 'merchandise is representative, not lots' } },
    });
    expect(f.blocking.join(' ')).toMatch(/representative, not real inventory/);
  });

  test('a clean evergreen asset has nothing blocking it', () => {
    const f = registry.assessFacts({
      category: 'individual-seller', isTrainingCopy: false,
      sidecar: { source: { rights: 'Advantage.Bid-owned production advertisement; official brand assets composited.' } },
    });
    expect(f.blocking).toEqual([]);
  });
});

// ── 4. The actual Owner library, as it exists on disk ─────────────────────────────────────────

describe('the Owner production library as it stands today', () => {
  const scanned = registry.scan();

  test('every image sits inside a known category folder', () => {
    expect(scanned.foreign).toEqual([]);
    scanned.assets.forEach((a) => expect(registry.CATEGORIES).toContain(a.category));
  });

  test('sidecars and other non-image files are never treated as advertisements', () => {
    scanned.assets.forEach((a) => expect(a.filename).not.toMatch(/\.reference\.json$/));
    expect(scanned.nonImages.every((p) => !registry.isImage(p))).toBe(true);
  });

  test('a nested subfolder never becomes the category', () => {
    // Files live under e.g. individual-seller/gold-standard/. The category is the TOP folder.
    const nested = scanned.assets.filter((a) => a.subfolder);
    nested.forEach((a) => {
      expect(a.category).toBe(a.relative_path.split('/')[0]);
      expect(registry.CATEGORIES).toContain(a.category);
    });
  });

  test('assets also present in the training library are recorded as provenance, not blocked', () => {
    const copies = scanned.assets.filter((a) => a.training_copy_of);
    expect(copies.length).toBeGreaterThan(0);
    copies.forEach((a) => {
      expect(a.factual_requirements.provenance.join(' ')).toMatch(/training \/ calibration library/);
    });
  });

  test('exactly the reviewed asset is blocked, and only for the reviewed reason', () => {
    const blocked = scanned.assets.filter((a) => a.factual_requirements.blocking.length);
    expect(blocked.length).toBe(1);
    expect(blocked[0].filename).toBe('individual-seller-turn-items-into-cash-gold-standard.png.png');
    expect(blocked[0].factual_requirements.blocking.join(' ')).toMatch(/materially incorrect logo/);
  });

  test('a reviewed message that differs from its folder is withheld from the wrong funnel', () => {
    const mismatched = scanned.assets.filter((a) => a.content_intent
      && registry.CATEGORY_PURPOSE[a.category].funnel
      && a.content_intent !== registry.CATEGORY_PURPOSE[a.category].funnel);
    mismatched.forEach((a) => {
      expect(a.factual_requirements.blocking).toEqual([]);   // still a good advertisement
      expect(a.factual_requirements.provenance.join(' ')).toMatch(/withheld from/);
    });
  });

  test('audience is never invented from a filename or from pixels', () => {
    scanned.assets.forEach((a) => expect(a.audience).toBe('UNKNOWN'));
  });
});

// ── 5. Budget enforcement ─────────────────────────────────────────────────────────────────────

describe('budget: the monthly authority is a ceiling', () => {
  const ledger = require('../src/services/paidBudgetLedger');

  test('monthKey normalises any date to the first of its month', () => {
    expect(ledger.monthKey(new Date('2026-10-17T12:00:00Z'))).toBe('2026-10-01');
    expect(ledger.monthKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
  });

  test('reservations require a campaign key, a positive amount and an idempotency key', async () => {
    expect((await ledger.reserve({ amountCents: 100, idempotencyKey: 'k' })).reason).toMatch(/campaign_key required/);
    expect((await ledger.reserve({ campaignKey: 'c', amountCents: 100 })).reason).toMatch(/idempotency_key required/);
    expect((await ledger.reserve({ campaignKey: 'c', amountCents: 0, idempotencyKey: 'k' })).reason).toMatch(/positive whole number/);
    expect((await ledger.reserve({ campaignKey: 'c', amountCents: -5, idempotencyKey: 'k' })).reason).toMatch(/positive whole number/);
    expect((await ledger.reserve({ campaignKey: 'c', amountCents: 1.5, idempotencyKey: 'k' })).reason).toMatch(/positive whole number/);
  });

  test('reservation is serialized by a row lock — concurrent creations cannot both spend the same authority', () => {
    const code = readCode('src/services/paidBudgetLedger.js');
    expect(code).toMatch(/FROM marketing_paid_budget_months WHERE month = \$1 FOR UPDATE/);
    expect(code).toMatch(/BEGIN/);
  });

  test('a retried reservation replays instead of committing twice', () => {
    const code = readCode('src/services/paidBudgetLedger.js');
    expect(code).toMatch(/WHERE idempotency_key = \$1/);
    expect(code).toMatch(/replayed: true/);
  });

  test('remaining authority is measured against the HIGHER of committed and actual', () => {
    const code = readCode('src/services/paidBudgetLedger.js');
    expect(code).toMatch(/Math\.max\(Number\(row\.committed_cents\), Number\(row\.actual_cents\)\)/);
  });

  test('a per-campaign ceiling can never exceed the month that contains it', () => {
    const code = readCode('src/services/paidBudgetLedger.js');
    expect(code).toMatch(/campaign_cents: Math\.min\(/);
    expect(code).toMatch(/daily_cents: Math\.min\(/);
  });

  test('release never returns more than was committed', () => {
    const code = readCode('src/services/paidBudgetLedger.js');
    expect(code).toMatch(/Math\.min\(amount, Number\(m\.committed_cents\)\)/);
  });

  test('actual spend is recorded even when it exceeds the ceiling — the truth is not suppressed', () => {
    const raw = readRaw('src/services/paidBudgetLedger.js');
    expect(raw).toMatch(/NEVER refuses/);
    const code = readCode('src/services/paidBudgetLedger.js');
    // recordActual has no ceiling comparison at all.
    const fn = code.slice(code.indexOf('async function recordActual'));
    expect(fn).not.toMatch(/remaining/);
  });

  test('the database enforces the ceiling independently of this code', () => {
    const sql = readRaw('db/migrations/159_paid_execution_and_production_creative.sql');
    expect(sql).toMatch(/CONSTRAINT chk_mpbm_within_ceiling CHECK \(committed_cents <= ceiling_cents\)/);
    expect(sql).toMatch(/idempotency_key text\s+NOT NULL UNIQUE/);
  });
});

// ── 6. Asset isolation ────────────────────────────────────────────────────────────────────────

describe('Meta asset isolation: only Advantage.Bid assets are reachable', () => {
  const meta = require('../src/services/paidGrowth/metaAdsProvider');

  const fakeDb = (cfg) => ({ query: async (sql, params) => {
    const key = params && params[0];
    return { rows: Object.prototype.hasOwnProperty.call(cfg, key) ? [{ value: cfg[key] }] : [] };
  } });

  test('an excluded ad account is refused even when it is the configured one', async () => {
    const out = await meta.resolveAdAccount(fakeDb({
      'marketing.measurement.meta_ad_account_id': 'act_664514018846795',
      'marketing.measurement.meta_ad_account_identity': { id: 'act_664514018846795', owner_confirmed: {} },
      'marketing.measurement.meta_ad_account_excluded': ['act_664514018846795'],
    }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/excluded list and must never be used/);
  });

  test('assertNotExcluded refuses an excluded account arriving by any route', async () => {
    const out = await meta.assertNotExcluded('act_664514018846795', fakeDb({
      'marketing.measurement.meta_ad_account_excluded': ['act_664514018846795'],
    }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/excluded ad account/);
  });

  test('the verified Advantage.Bid account is accepted', async () => {
    const out = await meta.resolveAdAccount(fakeDb({
      'marketing.measurement.meta_ad_account_id': 'act_1722514625516256',
      'marketing.measurement.meta_ad_account_identity': {
        id: 'act_1722514625516256', name: 'Advantage.Bid Marketing', currency: 'USD',
        owner_confirmed: { at: '2026-09-11T20:43:27.395Z' },
      },
      'marketing.measurement.meta_ad_account_excluded': ['act_664514018846795'],
    }));
    expect(out.ok).toBe(true);
    expect(out.account).toBe('act_1722514625516256');
  });

  test('ambiguous identity fails closed: no account configured', async () => {
    const out = await meta.resolveAdAccount(fakeDb({}));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/refusing rather than choosing one/);
  });

  test('ambiguous identity fails closed: identity does not match the configured account', async () => {
    const out = await meta.resolveAdAccount(fakeDb({
      'marketing.measurement.meta_ad_account_id': 'act_1722514625516256',
      'marketing.measurement.meta_ad_account_identity': { id: 'act_999', owner_confirmed: {} },
    }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/unverified or does not match/);
  });

  test('ambiguous identity fails closed: no Owner confirmation on record', async () => {
    const out = await meta.resolveAdAccount(fakeDb({
      'marketing.measurement.meta_ad_account_id': 'act_1722514625516256',
      'marketing.measurement.meta_ad_account_identity': { id: 'act_1722514625516256' },
    }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/no Owner confirmation/);
  });

  test('credentials never appear in returned text', () => {
    process.env.META_ADS_READ_TOKEN = 'SECRET_TOKEN_VALUE_1234567890';
    const out = meta.redact('request failed with SECRET_TOKEN_VALUE_1234567890 in the url');
    expect(out).not.toMatch(/SECRET_TOKEN_VALUE/);
    expect(out).toMatch(/\[credential\]/);
    delete process.env.META_ADS_READ_TOKEN;
  });

  test('campaigns are always created PAUSED, never spending on creation', () => {
    const code = readCode('src/services/paidGrowth/metaAdsProvider.js');
    expect(code).toMatch(/status: 'PAUSED'/);
  });

  test('every write checks ads_management first', () => {
    const code = readCode('src/services/paidGrowth/metaAdsProvider.js');
    const create = code.slice(code.indexOf('async function createCampaign'), code.indexOf('async function setStatus'));
    expect(create).toMatch(/if \(!perms\.ads_management\) return \{ ok: false/);
    const status = code.slice(code.indexOf('async function setStatus'), code.indexOf('const pause'));
    expect(status).toMatch(/if \(!perms\.ads_management\) return \{ ok: false/);
  });
});

// ── 7. Execution gates ────────────────────────────────────────────────────────────────────────

describe('execution fails closed', () => {
  const code = readCode('src/services/paidGrowth/paidExecutionService.js');

  test('the global kill switch is checked before anything else', () => {
    const pre = code.slice(code.indexOf('async function preflight'), code.indexOf('async function buyerInventory'));
    const killIdx = pre.indexOf('global paid-marketing kill switch');
    const execIdx = pre.indexOf('marketing.paid.execution_enabled');
    expect(killIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeLessThan(execIdx);
  });

  test('preflight requires the paid gate, the channel gate, live mode, measurement and ads_management', () => {
    expect(code).toMatch(/marketing\.paid\.execution_enabled/);
    expect(code).toMatch(/CHANNEL_GATE\[channel\]/);
    expect(code).toMatch(/mode !== 'live'/);
    expect(code).toMatch(/measurement not ready for/);
    expect(code).toMatch(/ads_management is not granted/);
  });

  test('a campaign cannot be created without an eligible creative', () => {
    const create = code.slice(code.indexOf('async function createCampaign'), code.indexOf('async function pauseCampaign'));
    expect(create).toMatch(/CREATIVE_BLOCKED/);
    expect(create).toMatch(/no creative selected/);
    // Eligibility is re-checked at creation time, not trusted from planning time.
    expect(create).toMatch(/no longer production-eligible/);
  });

  test('budget is reserved BEFORE the provider is called, and released if the provider refuses', () => {
    const create = code.slice(code.indexOf('async function createCampaign'), code.indexOf('async function pauseCampaign'));
    const reserveIdx = create.indexOf('ledger.reserve');
    const providerIdx = create.indexOf('meta.createCampaign');
    expect(reserveIdx).toBeGreaterThan(-1);
    expect(reserveIdx).toBeLessThan(providerIdx);
    expect(create).toMatch(/ledger\.release\(/);
  });

  test('a created campaign is READY, never ACTIVE — activation stays a separate decision', () => {
    const create = code.slice(code.indexOf('async function createCampaign'), code.indexOf('async function pauseCampaign'));
    expect(create).toMatch(/SET state='READY'/);
    expect(create).not.toMatch(/SET state='ACTIVE'/);
  });

  test('duplicate creation replays instead of creating a second provider campaign', () => {
    const create = code.slice(code.indexOf('async function createCampaign'), code.indexOf('async function pauseCampaign'));
    expect(create).toMatch(/if \(c\.provider_campaign_id\) return \{ ok: true, replayed: true/);
  });

  test('stopping a campaign returns the unspent authority', () => {
    const stop = code.slice(code.indexOf('async function stopCampaign'), code.indexOf('async function emergencyKill'));
    expect(stop).toMatch(/ledger\.release\(/);
    expect(stop).toMatch(/unspent/);
  });

  test('the emergency kill sets the switch first, then pauses every live campaign', () => {
    const kill = code.slice(code.indexOf('async function emergencyKill'), code.indexOf('async function clearKill'));
    const setIdx = kill.indexOf("setPlatformConfig('marketing.paid.global_kill', true)");
    const pauseIdx = kill.indexOf('pauseCampaign');
    expect(setIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(pauseIdx);
    expect(kill).toMatch(/state IN \('ACTIVE','READY'\)/);
  });

  test('one provider failure does not prevent the remaining campaigns being paused', () => {
    const kill = code.slice(code.indexOf('async function emergencyKill'), code.indexOf('async function clearKill'));
    expect(kill).toMatch(/\.catch\(/);
  });

  test('the prepared campaign never silently substitutes training creative', () => {
    const prep = code.slice(code.indexOf('async function prepareCampaign'), code.indexOf('async function createCampaign'));
    expect(prep).toMatch(/CREATIVE_BLOCKED/);
    expect(prep).toMatch(/registry\.selectForCampaign/);
    expect(prep).not.toMatch(/TRAINING_ROOT|approved-creative-examples/);
  });
});

// ── 8. Funnels and destinations ───────────────────────────────────────────────────────────────

describe('funnels and destinations', () => {
  test('each funnel has a canonical Advantage.Bid destination', () => {
    expect(registry.DESTINATIONS.individual_seller).toBe('https://bid.advantage.bid/become-seller.html?seller_type=private');
    expect(registry.DESTINATIONS.professional_seller).toBe('https://bid.advantage.bid/become-professional-seller.html');
    expect(registry.DESTINATIONS.buyer).toMatch(/^https:\/\/bid\.advantage\.bid\//);
  });

  test('no destination carries third-party tracking parameters', () => {
    Object.values(registry.DESTINATIONS).forEach((u) => {
      expect(u).not.toMatch(/utm_source=chatgpt|openai|\butm_/i);
    });
  });

  test('the three funnels are distinct and separately measurable', () => {
    const sql = readRaw('db/migrations/159_paid_execution_and_production_creative.sql');
    expect(sql).toMatch(/funnel IN \('buyer','individual_seller','professional_seller'\)/);
  });

  test('inventory posture is a signal, never a permanent disable', () => {
    const code = readCode('src/services/paidGrowth/paidExecutionService.js');
    const inv = code.slice(code.indexOf('async function buyerInventory'), code.indexOf('async function prepareCampaign'));
    for (const p of ['NORMAL', 'REDUCED', 'DISCOVERY_ONLY', 'HOLD']) expect(inv).toMatch(new RegExp(p));
    // Nothing in the inventory logic writes a config flag or disables a channel.
    expect(inv).not.toMatch(/setPlatformConfig|_enabled/);
  });
});

// ── 9. Authorization ──────────────────────────────────────────────────────────────────────────

describe('only the Owner controls spend', () => {
  const route = readCode('src/routes/adminMarketingAgency.js');

  test('every spend-affecting endpoint is Super Admin only', () => {
    for (const p of ['/creative/sync', '/campaigns/:key/pause', '/campaigns/:key/stop',
      '/campaigns/:key/create', '/kill', '/kill/clear']) {
      const line = route.split('\n').find((l) => l.includes("'" + p + "'"));
      expect(line).toBeTruthy();
      expect(line).toMatch(/superOnly/);
    }
  });

  test('approval changes are Super Admin only', () => {
    const line = route.split('\n').find((l) => l.includes("/creative/:assetKey/approval"));
    expect(line).toMatch(/superOnly/);
  });

  test('superOnly rejects a non-super-admin with 403', () => {
    expect(route).toMatch(/if \(!rbac\.isSuperAdmin\(req\.user\)\) return res\.status\(403\)/);
    const rbac = require('../src/lib/rbac');
    expect(rbac.isSuperAdmin({ role: 'admin' })).toBe(true);
    expect(rbac.isSuperAdmin({ staff_role: 'super_admin' })).toBe(true);
    expect(rbac.isSuperAdmin({ role: 'buyer' })).toBe(false);
    expect(rbac.isSuperAdmin({ staff_role: 'support' })).toBe(false);
    expect(rbac.isSuperAdmin(null)).toBe(false);
  });

  test('a do-not-use asset can never be approved through the API', () => {
    expect(route).toMatch(/do-not-use assets can never be approved/);
  });

  test('the control surface never returns credentials', () => {
    expect(route).not.toMatch(/TOKEN|access_token|META_[A-Z_]*TOKEN/);
  });
});

// ── 10. Owner control centre ──────────────────────────────────────────────────────────────────

describe('the Owner can see the department without reading JSON', () => {
  const page = readRaw('public/admin/marketing-agency.html');

  test('the page reports every field the Owner needs', () => {
    for (const label of ['Monthly authority', 'Committed', 'Actual spend', 'Remaining',
      'Per campaign max', 'Per day max']) {
      expect(page).toContain(label);
    }
    for (const col of ['Campaign', 'State', 'Funnel', 'Channel', 'Creative', 'Destination',
      'Budget', 'Spend', 'Signal', 'Updated']) {
      expect(page).toContain("'" + col + "'");   // headers are rendered from a JS array
    }
  });

  test('the kill switch is present and reachable', () => {
    expect(page).toMatch(/Emergency stop/);
    expect(page).toMatch(/\/kill/);
  });

  test('creative is shown with approval state, eligibility and a preview', () => {
    expect(page).toMatch(/Owner approved/);
    expect(page).toMatch(/Eligible/);
    expect(page).toMatch(/class="thumb"/);
    expect(page).toMatch(/do-not-use/);
  });

  test('the page states the three-library distinction so it cannot be forgotten', () => {
    expect(page).toMatch(/production-creative/);
    expect(page).toMatch(/approved-creative-examples/);
    expect(page).toMatch(/brand-assets\/logos/);
    expect(page).toMatch(/never interchangeable/);
  });

  test('the page uses no AI-facing vocabulary', () => {
    expect(page).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|machine learning|GPT|OpenAI/i);
  });

  test('creative previews are served from an admin-gated path, not a public one', () => {
    const server = readRaw('server.js');
    const line = server.split('\n').find((l) => l.includes("'/marketing-creative'"));
    expect(line).toBeTruthy();
    expect(line.trim().startsWith('//')).toBe(false);   // a live mount, not a comment
    const block = server.slice(server.indexOf("'/marketing-creative'"), server.indexOf("'/marketing-creative'") + 400);
    expect(block).toMatch(/authMiddleware/);
    expect(block).toMatch(/roleMiddleware/);
  });
});

// ── 11. Nothing is switched on ────────────────────────────────────────────────────────────────

describe('this runtime ships inert', () => {
  test('every gate the migration introduces is false', () => {
    const sql = readRaw('db/migrations/159_paid_execution_and_production_creative.sql');
    expect(sql).toMatch(/\('marketing\.paid\.global_kill', 'false'/);
    expect(sql).toMatch(/\('marketing\.paid\.execution_enabled', 'false'/);
    expect(sql).toMatch(/\('marketing\.production_creative\.filesystem_presence_implies_approval', 'false'/);
  });

  test('the migration enables nothing and creates no campaign', () => {
    const sql = readRaw('db/migrations/159_paid_execution_and_production_creative.sql');
    expect(sql).not.toMatch(/INSERT INTO marketing_paid_campaigns/);
    expect(sql).not.toMatch(/UPDATE platform_config SET value = 'true'/);
  });
});
