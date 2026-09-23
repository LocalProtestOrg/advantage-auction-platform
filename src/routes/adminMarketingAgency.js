'use strict';

/**
 * /api/admin/marketing-agency — the Owner's view of, and control over, the paid acquisition runtime.
 *
 * The readiness audit found the runtime was headless: a rich API with nothing consuming it, and 36
 * creative candidates held for an Owner review that had no screen. This is the surface that fixes
 * that — deliberately built on the existing Admin architecture rather than as a separate app.
 *
 * PERMISSIONS. Reading requires an admin session. Anything that can start, stop or unblock SPENDING
 * requires Super Admin, because spend authority is the Owner's, not general staff's.
 *
 * NO SECRETS. Tokens, ad-account credentials and provider identifiers beyond the account reference
 * are never returned. The Owner sees what is happening, not what it is authenticated with.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const rbac = require('../lib/rbac');
const db = require('../db');
const ledger = require('../services/paidBudgetLedger');
const registry = require('../services/productionCreativeRegistry');
const execution = require('../services/paidGrowth/paidExecutionService');
const configService = require('../services/configService');
const governance = require('../services/paidGrowth/paidSpendGovernance');

router.use(express.json());
router.use(auth, requirePermission('members.view'));

/** Spend control is Owner-level, not staff-level. */
function superOnly(req, res, next) {
  if (!rbac.isSuperAdmin(req.user)) return res.status(403).json({ success: false, message: 'Super Admin required' });
  next();
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── OVERVIEW ──────────────────────────────────────────────────────────────────────────────────

/** Everything the Owner needs to answer "what is my marketing department doing and what is it costing me?" */
router.get('/overview', asyncRoute(async (req, res) => {
  const [budget, pre, inventory] = await Promise.all([
    ledger.status(),
    execution.preflight({ channel: 'meta_ads' }).catch((e) => ({ ok: false, reasons: ['preflight error: ' + e.message] })),
    execution.buyerInventory().catch(() => null),
  ]);

  const campaigns = (await db.query(`
    SELECT c.campaign_key, c.channel, c.funnel, c.objective, c.market, c.audience, c.destination_url,
           c.budget_cents, c.daily_budget_cents, c.state, c.blocked_reason, c.provider_account_ref,
           c.provider_campaign_id, c.created_at, c.activated_at, c.paused_at, c.stopped_at, c.updated_at,
           pc.asset_key AS creative_asset_key, pc.filename AS creative_filename, pc.category AS creative_category,
           COALESCE((SELECT sum(amount_cents) FROM marketing_paid_budget_ledger l
                      WHERE l.campaign_key = c.campaign_key AND l.kind = 'actual'), 0)::int AS actual_spend_cents,
           s.signal_state, s.last_evaluated_at
      FROM marketing_paid_campaigns c
      LEFT JOIN marketing_production_creative pc ON pc.id = c.creative_id
      LEFT JOIN marketing_paid_campaign_states s ON s.campaign_key = c.campaign_key
     ORDER BY c.created_at DESC`)).rows;

  const byState = campaigns.reduce((a, c) => { a[c.state] = (a[c.state] || 0) + 1; return a; }, {});
  const killOn = await execution.killed();

  res.json({
    success: true,
    data: {
      paid_marketing_status: pre.ok ? 'READY TO EXECUTE' : 'OFF',
      paid_marketing_blockers: pre.reasons || [],
      global_kill: { engaged: killOn, available: true },
      monthly_authority_cents: budget.ceiling_cents,
      committed_spend_cents: budget.committed_cents,
      actual_spend_cents: budget.actual_cents,
      remaining_authority_cents: budget.remaining_cents,
      campaign_ceiling_cents: budget.campaign_ceiling_cents,
      // A nominal plan for configured provider daily budgets — a pacing target, NOT a hard limit.
      nominal_daily_budget_plan_cents: budget.daily_ceiling_cents,
      authorized_unspent_cents: budget.unspent_exposure_cents,
      total_exposure_cents: budget.consumed_cents,
      month: budget.month,
      buyer_inventory: inventory,
      counts: {
        active: byState.ACTIVE || 0, ready: byState.READY || 0, planned: byState.PLANNED || 0,
        paused: byState.PAUSED || 0, stopped: byState.STOPPED || 0,
        creative_blocked: byState.CREATIVE_BLOCKED || 0, failed: byState.FAILED || 0,
      },
      campaigns,
      provider: { channel: 'meta_ads', account_ref: pre.account || null, permissions: pre.permissions || null },
    },
  });
}));

// ── SPEND GOVERNANCE ──────────────────────────────────────────────────────────────────────────

/**
 * The money picture in the order the Owner reads it: ceiling → actually spent → authorized but
 * unspent → total exposure → uncommitted → pacing → projection → reconciliation. Everything comes
 * from the last successful provider read plus the ledger; nothing here calls the provider.
 */
router.get('/spend', asyncRoute(async (req, res) => {
  res.json({ success: true, data: await governance.overview() });
}));

/** Re-read provider spend now. Read-only at the provider (a CEILING_BREACH still pauses — safety wins). */
router.post('/spend/sync', superOnly, asyncRoute(async (req, res) => {
  const out = await governance.syncSpend({ trigger: 'owner_manual' });
  res.status(out.ok ? 200 : 502).json({ success: out.ok, data: out.ok
    ? { state: out.reconciliation.state, flags: out.reconciliation.flags, ledger_entries: out.ledger_entries, actions: out.actions }
    : { reason: out.reason } });
}));

/**
 * Pacing and freshness settings. The monthly, per-campaign and daily-plan ceilings are deliberately
 * NOT editable here: this surface tunes how conservatively the authority is paced, never how much
 * authority exists.
 */
const SPEND_SETTINGS = Object.freeze({
  'marketing.paid.pacing.daily_budget_safety_factor': { type: 'number', min: 0.1, max: 1 },
  'marketing.paid.pacing.provider_max_daily_overdelivery': { type: 'number', min: 1, max: 5 },
  'marketing.paid.spend_sync.interval_minutes': { type: 'number', min: 5, max: 1440 },
  'marketing.paid.spend_sync.max_age_minutes': { type: 'number', min: 5, max: 2880 },
  'marketing.paid.spend_sync.decision_max_age_minutes': { type: 'number', min: 1, max: 240 },
  'marketing.paid.spend_sync.tolerance_cents': { type: 'number', min: 0, max: 10000 },
  'marketing.paid.auto_pause_on_breach': { type: 'boolean' },
});

router.post('/spend/settings', superOnly, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const applied = {};
  for (const [key, value] of Object.entries(body)) {
    const rule = SPEND_SETTINGS[key];
    if (!rule) return res.status(400).json({ success: false, message: 'Not an editable spend setting: ' + key });
    if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') return res.status(400).json({ success: false, message: key + ' must be true or false' });
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || n < rule.min || n > rule.max) {
        return res.status(400).json({ success: false, message: `${key} must be between ${rule.min} and ${rule.max}` });
      }
    }
    applied[key] = rule.type === 'boolean' ? value : Number(value);
  }
  for (const [k, v] of Object.entries(applied)) await configService.setPlatformConfig(k, v);
  res.json({ success: true, data: { applied, settings: (await governance.overview()).settings } });
}));

/** Why can (or can't) anything run right now. */
router.get('/preflight', asyncRoute(async (req, res) => {
  const channel = String(req.query.channel || 'meta_ads');
  res.json({ success: true, data: await execution.preflight({ channel }) });
}));

// ── CREATIVE ──────────────────────────────────────────────────────────────────────────────────

/** The production creative inventory, so the Owner never has to read JSON to run the business. */
router.get('/creative', asyncRoute(async (req, res) => {
  const rows = (await db.query(`
    SELECT id, asset_key, filename, relative_path, category, campaign_purpose, audience,
           destination_type, evergreen, owner_approved_for_production, approval_source,
           production_eligible, ineligible_reason, provenance, provenance_conflict,
           factual_requirements, width, height, status, registered_at,
           (SELECT count(*)::int FROM marketing_paid_campaigns c WHERE c.creative_id = marketing_production_creative.id) AS campaign_usage
      FROM marketing_production_creative ORDER BY category, filename`)).rows;
  const summary = rows.reduce((a, r) => {
    a.total += 1;
    if (r.category === 'do-not-use') a.do_not_use += 1;
    if (r.owner_approved_for_production) a.approved += 1;
    if (r.production_eligible) a.eligible += 1;
    if (r.provenance_conflict) a.conflicted += 1;
    a.by_category[r.category] = (a.by_category[r.category] || 0) + 1;
    return a;
  }, { total: 0, approved: 0, eligible: 0, do_not_use: 0, conflicted: 0, by_category: {} });
  res.json({ success: true, data: { summary, assets: rows, roots: {
    production: 'docs/marketing/production-creative',
    training_reference_only: 'docs/marketing/approved-creative-examples',
    official_brand_assets: 'docs/marketing/brand-assets/logos',
  } } });
}));

/** Re-read the library. Never grandfathers: presence is not approval after initialization. */
router.post('/creative/sync', superOnly, asyncRoute(async (req, res) => {
  const out = await registry.sync({ grandfather: false });
  res.json({ success: true, data: { registered: out.registered.length, grandfathered: out.grandfathered,
    already_grandfathered: out.already_grandfathered, foreign: out.foreign, non_images: out.nonImages.length } });
}));

/** An explicit Owner approval decision for one asset. The only way a new asset becomes approved. */
router.post('/creative/:assetKey/approval', superOnly, asyncRoute(async (req, res) => {
  const approved = req.body && req.body.approved === true;
  const row = (await db.query('SELECT id, category, factual_requirements FROM marketing_production_creative WHERE asset_key = $1', [req.params.assetKey])).rows[0];
  if (!row) return res.status(404).json({ success: false, message: 'Unknown asset' });
  if (row.category === 'do-not-use') return res.status(400).json({ success: false, message: 'do-not-use assets can never be approved' });
  const blocking = (row.factual_requirements && row.factual_requirements.blocking) || [];
  const eligible = approved && blocking.length === 0;
  await db.query(
    `UPDATE marketing_production_creative
        SET owner_approved_for_production=$2, approval_source='owner_review', approval_recorded_at=now(),
            production_eligible=$3,
            ineligible_reason=CASE WHEN $3 THEN NULL WHEN $2 THEN $4 ELSE 'not approved for production' END,
            provenance=CASE WHEN $2 THEN 'OWNER_APPROVED_PRODUCTION' ELSE 'REGISTERED_UNAPPROVED' END,
            updated_at=now()
      WHERE id=$1`, [row.id, approved, eligible, blocking.join('; ') || null]);
  res.json({ success: true, data: { asset_key: req.params.assetKey, approved, production_eligible: eligible,
    still_blocking: eligible ? [] : blocking } });
}));

// ── AUDIENCE INTELLIGENCE ─────────────────────────────────────────────────────────────────────

/**
 * Who we are trying to reach, why, what Meta is actually targeting, how big it is, what it cost and
 * what the Director learned — in plain English, with the provider specification available but not
 * forced on the reader.
 */
router.get('/audiences', asyncRoute(async (req, res) => {
  const strategies = (await db.query(`
    SELECT s.id, s.strategy_key, s.funnel, s.hypothesis, s.rationale, s.audience_mode, s.geography,
           s.inclusions, s.exclusions, s.optimization_goal, s.validation_state, s.validation_detail,
           s.last_validated_at, s.estimated_reach_lower, s.estimated_reach_upper, s.learning_state,
           s.policy_status, s.policy_detail, s.active, s.targeting_spec,
           COALESCE(f.spend_cents,0)::int   AS spend_cents,
           COALESCE(f.impressions,0)::int   AS impressions,
           COALESCE(f.clicks,0)::int        AS clicks,
           COALESCE(f.landing_visits,0)::int AS landing_visits,
           COALESCE(f.registrations,0)::int AS registrations,
           COALESCE(f.qualified,0)::int     AS qualified_conversions,
           l.decision AS last_decision, l.reason AS last_reason, l.recorded_at AS last_decided_at
      FROM marketing_audience_strategies s
      LEFT JOIN LATERAL (
        SELECT sum(a.spend_cents) spend_cents, sum(a.impressions) impressions, sum(a.clicks) clicks,
               sum(a.landing_visits) landing_visits, sum(a.registrations) registrations,
               sum(a.qualified_conversions) qualified
          FROM marketing_audience_experiment_arms a WHERE a.strategy_id = s.id) f ON true
      LEFT JOIN LATERAL (
        SELECT decision, reason, recorded_at FROM marketing_audience_learnings ml
         WHERE ml.strategy_id = s.id ORDER BY recorded_at DESC LIMIT 1) l ON true
     ORDER BY s.funnel, s.strategy_key`)).rows;

  const experiments = (await db.query(`
    SELECT e.experiment_key, e.campaign_key, e.funnel, e.state, e.hypothesis, e.campaign_budget_cents,
           json_agg(json_build_object('arm', a.arm_label, 'strategy', s.strategy_key,
             'allocated_cents', a.allocated_cents, 'spend_cents', a.spend_cents,
             'landing_visits', a.landing_visits, 'registrations', a.registrations,
             'qualified', a.qualified_conversions) ORDER BY a.arm_label) AS arms,
           COALESCE(sum(a.allocated_cents),0)::int AS allocated_cents
      FROM marketing_audience_experiments e
      LEFT JOIN marketing_audience_experiment_arms a ON a.experiment_id = e.id
      LEFT JOIN marketing_audience_strategies s ON s.id = a.strategy_id
     GROUP BY e.id ORDER BY e.experiment_key`)).rows;

  res.json({ success: true, data: { strategies, experiments } });
}));

/** Re-validate a strategy against the provider. Capability is never assumed permanent. */
router.post('/audiences/:strategyKey/revalidate', superOnly, asyncRoute(async (req, res) => {
  const ai = require('../services/paidGrowth/audienceIntelligenceService');
  const s = (await db.query('SELECT * FROM marketing_audience_strategies WHERE strategy_key=$1', [req.params.strategyKey])).rows[0];
  if (!s) return res.status(404).json({ success: false, message: 'Unknown strategy' });
  const out = await ai.upsertStrategy({
    strategyKey: s.strategy_key, funnel: s.funnel, hypothesis: s.hypothesis, rationale: s.rationale,
    geography: s.geography, inclusions: s.inclusions, exclusions: s.exclusions,
    optimizationGoal: s.optimization_goal, audienceMode: s.audience_mode, provenance: 'owner_revalidation',
  });
  res.json({ success: true, data: { strategy_key: s.strategy_key, validation_state: out.validation_state,
    policy: out.policy, reach: { lower: out.strategy.estimated_reach_lower, upper: out.strategy.estimated_reach_upper } } });
}));

// -- DELIVERY CHAIN ---------------------------------------------------------------------------

/**
 * The complete hierarchy the Owner can inspect: campaign -> experiment -> ad set / audience ->
 * creative package -> ad. Provider ids are available for diagnostics, but the reading order is the
 * business one: who, why, where, what it says, where it sends them.
 */
router.get('/delivery', asyncRoute(async (req, res) => {
  const packages = (await db.query(`
    SELECT p.package_key, p.funnel, p.audience_purpose, p.primary_text, p.headline, p.description,
           p.cta_type, p.destination_url, p.version, p.fingerprint, p.approval_state, p.policy_status,
           p.policy_detail, p.active, c.filename AS image_filename, c.asset_key AS image_asset_key,
           c.production_eligible AS image_eligible,
           (SELECT provider_image_hash FROM marketing_provider_images i
             WHERE i.production_creative_id = c.id LIMIT 1) AS provider_image_hash
      FROM marketing_creative_packages p
      JOIN marketing_production_creative c ON c.id = p.production_creative_id
     ORDER BY p.funnel, p.package_key`)).rows;

  const objects = (await db.query(`
    SELECT object_type, provider_id, parent_provider_id, campaign_key, package_key, provider_status,
           intended_status, certification_artifact, last_error, created_at, last_reconciled_at
      FROM marketing_provider_objects ORDER BY created_at DESC LIMIT 200`)).rows;

  const arms = (await db.query(`
    SELECT e.experiment_key, e.campaign_key, e.funnel, e.campaign_budget_cents, a.arm_label,
           a.allocated_cents, a.provider_adset_id, a.spend_cents, a.impressions, a.clicks,
           a.landing_visits, a.registrations, s.strategy_key, s.hypothesis, s.audience_mode,
           s.validation_state, s.estimated_reach_lower, s.estimated_reach_upper, s.learning_state
      FROM marketing_audience_experiments e
      JOIN marketing_audience_experiment_arms a ON a.experiment_id = e.id
      JOIN marketing_audience_strategies s ON s.id = a.strategy_id
     ORDER BY e.experiment_key, a.arm_label`)).rows;

  const buildMode = await configService.get(null, 'marketing.paid.build_mode');
  res.json({ success: true, data: { build_mode: buildMode === true, packages, objects, arms } });
}));

// ── CAMPAIGN CONTROL ──────────────────────────────────────────────────────────────────────────

router.post('/campaigns/:key/pause', superOnly, asyncRoute(async (req, res) => {
  const out = await execution.pauseCampaign({ campaignKey: req.params.key, reason: (req.body && req.body.reason) || 'owner paused' });
  res.status(out.ok ? 200 : 400).json({ success: out.ok, data: out });
}));

router.post('/campaigns/:key/stop', superOnly, asyncRoute(async (req, res) => {
  const out = await execution.stopCampaign({ campaignKey: req.params.key, reason: (req.body && req.body.reason) || 'owner stopped' });
  res.status(out.ok ? 200 : 400).json({ success: out.ok, data: out });
}));

/** Create at the provider. Refuses unless every preflight gate is open — including the Owner's own. */
router.post('/campaigns/:key/create', superOnly, asyncRoute(async (req, res) => {
  const out = await execution.createCampaign({ campaignKey: req.params.key });
  res.status(out.ok ? 200 : 400).json({ success: out.ok, data: out });
}));

// ── KILL SWITCH ───────────────────────────────────────────────────────────────────────────────

router.post('/kill', superOnly, asyncRoute(async (req, res) => {
  res.json({ success: true, data: await execution.emergencyKill({ reason: (req.body && req.body.reason) || 'owner emergency stop' }) });
}));

router.post('/kill/clear', superOnly, asyncRoute(async (req, res) => {
  res.json({ success: true, data: await execution.clearKill() });
}));

/** The gates themselves, so the Owner can see every switch in one place. */
router.get('/gates', asyncRoute(async (req, res) => {
  const keys = ['marketing.paid.global_kill', 'marketing.paid.execution_enabled',
    'marketing.paid_growth.mode', 'marketing.paid_growth.monthly_ceiling_usd',
    'marketing.paid_growth.campaign_ceiling_usd', 'marketing.paid_growth.daily_ceiling_usd',
    'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled',
    'marketing.a9_publish_enabled', 'marketing.email.sales_near_you_enabled',
    'marketing.production_creative.filesystem_presence_implies_approval',
    ...Object.keys(SPEND_SETTINGS), 'marketing.paid.pacing.timezone'];
  const out = {};
  for (const k of keys) out[k] = await configService.get(null, k);
  res.json({ success: true, data: out });
}));

module.exports = router;
