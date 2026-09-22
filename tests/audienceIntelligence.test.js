'use strict';

/**
 * Audience intelligence + targeting.
 *
 * The properties that matter here are: a targeting id is never trusted without the provider's own
 * confirmation, a sensitive personal status never becomes targeting, audience testing shares a
 * campaign's budget instead of multiplying it, and a judgement is never drawn from a sample too
 * small to support it.
 *
 * The database-level guarantee (an unvalidated strategy cannot be marked active) is additionally
 * proven against production by scripts/prod-migrate-160.js.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readCode = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const readRaw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ai = require('../src/services/paidGrowth/audienceIntelligenceService');

// ── policy: sensitive inference is refused ────────────────────────────────────────────────────

describe('sensitive personal status never becomes targeting', () => {
  test('a hypothesis built on marital breakdown is refused', () => {
    const r = ai.policyCheck({ hypothesis: 'People going through a divorce need to sell household contents fast' });
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toMatch(/marital breakdown/);
  });

  test('bereavement, financial distress, health and protected characteristics are all refused', () => {
    const cases = [
      ['Recently widowed homeowners clearing a house', /bereavement/],
      ['Homeowners facing foreclosure who need cash', /financial distress/],
      ['People with a dementia diagnosis downsizing', /health status/],
      ['Target by religion for estate sales', /protected characteristic/],
      ['Elderly people who cannot manage their possessions', /vulnerability/],
    ];
    for (const [hypothesis, why] of cases) {
      const r = ai.policyCheck({ hypothesis });
      expect(r.ok).toBe(false);
      expect(r.violations.join(' ')).toMatch(why);
    }
  });

  test('a legitimate category-interest hypothesis passes', () => {
    const r = ai.policyCheck({
      hypothesis: 'People interested in antiques, collectables and auctions understand what their things are worth',
      rationale: 'Category familiarity is a lawful, general interest signal',
      targetingSpec: { age_min: 25 },
    });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test('seller acquisition may never target minors', () => {
    expect(ai.MIN_AGE).toBeGreaterThanOrEqual(18);
    expect(ai.policyCheck({ hypothesis: 'ok', targetingSpec: { age_min: 16 } }).ok).toBe(false);
    expect(ai.policyCheck({ hypothesis: 'ok', targetingSpec: { age_min: 25 } }).ok).toBe(true);
  });

  test('the sensitive check also reads the targeting labels, not only the prose', () => {
    const r = ai.policyCheck({ hypothesis: 'clean', labels: ['Recently divorced'] });
    expect(r.ok).toBe(false);
  });
});

// ── targeting specification ───────────────────────────────────────────────────────────────────

describe('the provider specification is built from ids, never from labels', () => {
  const inclusions = [
    { type: 'interests', id: '6003570738103', name: 'Antique' },
    { type: 'interests', id: '6003376576804', name: 'Collectable' },
    { type: 'behaviors', id: '6002714898572', name: 'Small business owners' },
  ];

  test('interests and behaviors are grouped by type and carry ids only', () => {
    const spec = ai.buildTargetingSpec({ inclusions });
    expect(spec.flexible_spec[0].interests).toEqual([{ id: '6003570738103' }, { id: '6003376576804' }]);
    expect(spec.flexible_spec[0].behaviors).toEqual([{ id: '6002714898572' }]);
    // No human-readable label is ever sent as targeting.
    expect(JSON.stringify(spec)).not.toMatch(/Antique|Collectable|Small business/);
  });

  test('geography is a resolved provider key with a radius, never a place name', () => {
    const spec = ai.buildTargetingSpec({ inclusions });
    expect(spec.geo_locations.cities[0].key).toBe(ai.HOUSTON_METRO.key);
    expect(spec.geo_locations.cities[0].radius).toBe(25);
    expect(JSON.stringify(spec.geo_locations)).not.toMatch(/Houston/);
  });

  test('every specification carries the minimum age', () => {
    for (const mode of ['detailed', 'broad', 'advantage_plus']) {
      expect(ai.buildTargetingSpec({ inclusions, audienceMode: mode }).age_min).toBe(ai.MIN_AGE);
    }
  });

  test('Advantage+ asks the provider to expand and sends no detailed targeting', () => {
    const spec = ai.buildTargetingSpec({ inclusions, audienceMode: 'advantage_plus' });
    expect(spec.targeting_automation).toEqual({ advantage_audience: 1 });
    expect(spec.flexible_spec).toBeUndefined();
  });

  test('exclusions are carried separately from inclusions', () => {
    const spec = ai.buildTargetingSpec({ inclusions, exclusions: [{ type: 'interests', id: '6003120721217' }] });
    expect(spec.exclusions.interests).toEqual([{ id: '6003120721217' }]);
  });
});

// ── validation is mandatory and authoritative ─────────────────────────────────────────────────

describe('a targeting id is never trusted without the provider confirming it', () => {
  test('validateTargeting treats anything not explicitly valid as unusable', () => {
    const code = readCode('src/services/paidGrowth/audienceIntelligenceService.js');
    expect(code).toMatch(/valid: v\.valid === true/);
    expect(code).toMatch(/all_valid: results\.length > 0 && results\.every\(\(x\) => x\.valid\)/);
  });

  test('validation runs against the canonical account and refuses an excluded one', () => {
    const code = readCode('src/services/paidGrowth/audienceIntelligenceService.js');
    const fn = code.slice(code.indexOf('async function validateTargeting'), code.indexOf('async function estimateReach'));
    expect(fn).toMatch(/assertNotExcluded/);
    expect(fn).toMatch(/resolveAdAccount/);
  });

  test('reach estimation also refuses an excluded account', () => {
    const code = readCode('src/services/paidGrowth/audienceIntelligenceService.js');
    const fn = code.slice(code.indexOf('async function estimateReach'), code.indexOf('function policyCheck'));
    expect(fn).toMatch(/assertNotExcluded/);
  });

  test('search results are labelled unvalidated so they cannot be mistaken for usable targeting', () => {
    const code = readCode('src/services/paidGrowth/audienceIntelligenceService.js');
    const fn = code.slice(code.indexOf('async function searchInterests'), code.indexOf('async function validateTargeting'));
    expect(fn).toMatch(/validated: false/);
  });

  test('the reason validation cannot be replaced by a reach estimate is documented', () => {
    const raw = readRaw('src/services/paidGrowth/audienceIntelligenceService.js');
    expect(raw).toMatch(/silently returns 0–0/);
    expect(raw).toMatch(/SEARCH → VALIDATE \(authoritative\) → ESTIMATE/);
  });

  test('the database refuses to activate a strategy the provider has not confirmed', () => {
    const sql = readRaw('db/migrations/160_audience_intelligence.sql');
    expect(sql).toMatch(/CONSTRAINT chk_mas_active_requires_valid CHECK \(\s*active = false OR \(validation_state = 'VALID' AND policy_status = 'OK'\)\)/);
  });
});

// ── budget containment ────────────────────────────────────────────────────────────────────────

describe('audience testing shares a campaign budget and never multiplies it', () => {
  test('arms are checked against the campaign budget, not added to it', () => {
    const code = readCode('src/services/paidGrowth/audienceIntelligenceService.js');
    const fn = code.slice(code.indexOf('async function planExperiment'), code.indexOf('async function assessArm'));
    expect(fn).toMatch(/if \(total > Number\(c\.budget_cents\)\)/);
    expect(fn).toMatch(/it never adds to it/);
  });

  test('an experiment may only use strategies the provider validated and policy allows', () => {
    const code = readCode('src/services/paidGrowth/audienceIntelligenceService.js');
    const fn = code.slice(code.indexOf('async function planExperiment'), code.indexOf('async function assessArm'));
    expect(fn).toMatch(/validation_state !== 'VALID'/);
    expect(fn).toMatch(/policy_status !== 'OK'/);
    expect(fn).toMatch(/s\.funnel !== c\.funnel/);   // a seller audience cannot be used on a buyer campaign
  });

  test('audience intelligence introduces no new spending authority', () => {
    const sql = readRaw('db/migrations/160_audience_intelligence.sql');
    expect(sql).not.toMatch(/monthly_ceiling_usd|campaign_ceiling_usd|daily_ceiling_usd/);
    expect(sql).toMatch(/first_party_upload_enabled', 'false'/);
  });

  test('arm allocations cannot be negative', () => {
    const sql = readRaw('db/migrations/160_audience_intelligence.sql');
    expect(sql).toMatch(/CONSTRAINT chk_maea_alloc CHECK \(allocated_cents >= 0\)/);
  });
});

// ── learning ──────────────────────────────────────────────────────────────────────────────────

describe('judgement waits for enough evidence', () => {
  const T = { minVisits: 100, minConversions: 5, targetCpaCents: 6000 };

  test('nothing delivered yet is NO_DATA and holds', async () => {
    const a = await ai.assessArm({ spend_cents: 0, landing_visits: 0 }, T);
    expect(a.state).toBe('NO_DATA');
    expect(a.decision).toBe('HOLD');
    expect(a.sample_sufficient).toBe(false);
  });

  test('a small sample is INSUFFICIENT_DATA and never declares a winner or a loser', async () => {
    const a = await ai.assessArm({ spend_cents: 2000, landing_visits: 40, qualified_conversions: 1 }, T);
    expect(a.state).toBe('INSUFFICIENT_DATA');
    expect(a.decision).toBe('CONTINUE');
    expect(a.sample_sufficient).toBe(false);
    expect(a.reason).toMatch(/below the 100 visit \/ 5 conversion floor/);
  });

  test('traffic that never converts, once the floor is reached, is paused', async () => {
    const a = await ai.assessArm({ spend_cents: 9000, landing_visits: 250, qualified_conversions: 0 }, T);
    expect(a.state).toBe('UNDERPERFORMING');
    expect(a.decision).toBe('PAUSE');
    expect(a.sample_sufficient).toBe(true);
  });

  test('cost far above target reduces rather than continues', async () => {
    const a = await ai.assessArm({ spend_cents: 90000, landing_visits: 300, qualified_conversions: 5 }, T);
    expect(a.state).toBe('UNDERPERFORMING');
    expect(a.decision).toBe('REDUCE');
    expect(a.cpa_cents).toBe(18000);
  });

  test('conversions at or below target are PROMISING', async () => {
    const a = await ai.assessArm({ spend_cents: 24000, landing_visits: 300, qualified_conversions: 5 }, T);
    expect(a.state).toBe('PROMISING');
    expect(a.decision).toBe('CONTINUE');
    expect(a.cpa_cents).toBe(4800);
  });

  test('cheap clicks alone never make an audience promising', async () => {
    // 5,000 visits, no conversions: a very cheap click and a worthless audience.
    const a = await ai.assessArm({ spend_cents: 5000, landing_visits: 5000, qualified_conversions: 0 }, T);
    expect(a.state).not.toBe('PROMISING');
    expect(a.decision).toBe('PAUSE');
  });

  test('every learning state the Director can record is representable', () => {
    const sql = readRaw('db/migrations/160_audience_intelligence.sql');
    for (const s of ['NO_DATA', 'INSUFFICIENT_DATA', 'PROMISING', 'UNDERPERFORMING',
      'POLICY_BLOCKED', 'PROVIDER_UNAVAILABLE', 'RETIRED']) {
      expect(sql).toContain("'" + s + "'");
    }
    for (const d of ['CONTINUE', 'REDUCE', 'PAUSE', 'RETIRE', 'RETEST', 'EXPAND_GEOGRAPHY',
      'CREATE_RELATED_HYPOTHESIS', 'HOLD']) {
      expect(sql).toContain("'" + d + "'");
    }
  });

  test('learning is persisted with its evidence so a failure is not rediscovered', () => {
    const code = readCode('src/services/paidGrowth/audienceIntelligenceService.js');
    expect(code).toMatch(/INSERT INTO marketing_audience_learnings/);
    expect(code).toMatch(/async function priorLearning/);
  });
});

// ── first-party data ──────────────────────────────────────────────────────────────────────────

describe('first-party audience upload is architected but off', () => {
  test('provider upload ships disabled and is not implemented as a side effect', () => {
    const sql = readRaw('db/migrations/160_audience_intelligence.sql');
    expect(sql).toMatch(/first_party_upload_enabled', 'false'/);
    const code = readCode('src/services/paidGrowth/audienceIntelligenceService.js');
    // Nothing in this service uploads a customer list to a provider.
    expect(code).not.toMatch(/customaudiences|users\/upload|payload.*schema.*EMAIL/i);
  });

  test('custom and lookalike remain declared audience modes for later, not silent capability', () => {
    const sql = readRaw('db/migrations/160_audience_intelligence.sql');
    expect(sql).toMatch(/'custom' \| 'lookalike'/);
  });
});

// ── Owner visibility ──────────────────────────────────────────────────────────────────────────

describe('the Owner can read the audience story in plain English', () => {
  const page = readRaw('public/admin/marketing-agency.html');

  test('the console answers the Owner questions', () => {
    for (const q of ['Audiences — who we are trying to reach', 'Why this audience', 'What Meta targets',
      'Where', 'Size', 'Provider check', 'Spend', 'Registrations', 'Learned']) {
      expect(page).toContain(q);
    }
  });

  test('experiments show allocation against the authorised campaign budget', () => {
    expect(page).toContain('Audience experiments');
    expect(page).toMatch(/never costs more/);
    expect(page).toMatch(/within budget/);
  });

  test('a provider-rejected targeting id is surfaced, not hidden', () => {
    expect(page).toMatch(/provider rejected/);
  });

  test('the page uses no AI-facing vocabulary', () => {
    expect(page).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|machine learning|GPT|OpenAI/i);
  });

  test('audience revalidation is Super Admin only', () => {
    const route = readCode('src/routes/adminMarketingAgency.js');
    const line = route.split('\n').find((l) => l.includes("/audiences/:strategyKey/revalidate"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/superOnly/);
  });
});
