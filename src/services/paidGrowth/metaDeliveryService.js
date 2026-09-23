'use strict';

/**
 * metaDeliveryService — assembles the complete Meta delivery chain from governed inputs.
 *
 *   CAMPAIGN  objective + spend cap            (what we are buying)
 *   AD SET    geography + audience + budget    (who sees it, where, for how much)
 *   CREATIVE  image + words + destination      (what they see, where it sends them)
 *   AD        campaign + ad set + creative     (the thing that can actually deliver)
 *
 * Every input is governed before it can reach the provider: the image must be production-eligible in
 * the creative registry, the words must be an Owner-approved creative package, the audience must be
 * a VALID Audience Intelligence strategy, and the budget must fit inside the campaign's already
 * authorized amount. Nothing is assembled from a free-text label.
 *
 * EVERYTHING IS CREATED PAUSED, and while `marketing.paid.build_mode` is on, nothing may be set
 * ACTIVE at all — so the whole chain can be proven against the real account without a single
 * impression being served.
 *
 * IDEMPOTENCY. Every provider object is written to marketing_provider_objects under a deterministic
 * idempotency key before and after creation. A retry or a restart reconciles against what already
 * exists rather than creating a second campaign, ad set, creative or ad.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../../db');
const configService = require('../configService');
const meta = require('./metaAdsProvider');
const registry = require('../productionCreativeRegistry');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/** Attribution every paid destination carries. Uses the existing UTM architecture, not a new one. */
function buildDestination({ destinationUrl, funnel, campaignKey, strategyKey, experimentKey, armLabel, packageKey }) {
  const u = new URL(destinationUrl);
  const set = (k, v) => { if (v) u.searchParams.set(k, String(v)); };
  set('utm_source', 'meta');
  set('utm_medium', 'paid_social');
  set('utm_campaign', campaignKey);
  set('utm_content', packageKey);
  set('utm_term', strategyKey);
  // Advantage.Bid-specific dimensions the Director needs to separate the funnels and the arms.
  set('adv_funnel', funnel);
  set('adv_experiment', experimentKey);
  set('adv_arm', armLabel);
  set('adv_provider', 'meta');
  return u.toString();
}

/** A package's fingerprint: change a word, change the fingerprint. */
function packageFingerprint(pkg) {
  return crypto.createHash('sha256').update(JSON.stringify({
    asset: pkg.asset_sha256, primary_text: pkg.primary_text, headline: pkg.headline,
    description: pkg.description || null, cta: pkg.cta_type, destination: pkg.destination_url,
  })).digest('hex');
}

/**
 * Upload a governed image once per account and reuse its provider hash thereafter.
 * Refuses anything the production registry does not consider eligible — a do-not-use asset, a
 * blocked asset, or a file merely present on disk.
 */
async function ensureImage({ productionCreativeId, account, runner = db } = {}) {
  const asset = (await runner.query(
    `SELECT id, sha256, filename, relative_path, production_eligible, ineligible_reason, category
       FROM marketing_production_creative WHERE id = $1`, [productionCreativeId])).rows[0];
  if (!asset) return { ok: false, reason: 'unknown production creative' };
  if (asset.category === 'do-not-use') return { ok: false, reason: 'do-not-use assets are never uploaded' };
  if (asset.production_eligible !== true) {
    return { ok: false, reason: 'asset is not production-eligible: ' + (asset.ineligible_reason || 'unapproved') };
  }

  const existing = (await runner.query(
    `SELECT provider_image_hash FROM marketing_provider_images
      WHERE provider='meta' AND account_ref=$1 AND asset_sha256=$2`, [account, asset.sha256])).rows[0];
  if (existing) return { ok: true, image_hash: existing.provider_image_hash, reused: true };

  const full = path.join(registry.PRODUCTION_ROOT, asset.relative_path);
  let bytes;
  try { bytes = fs.readFileSync(full); } catch (e) { return { ok: false, reason: 'asset file unreadable: ' + e.message }; }
  // The bytes must still be the governed bytes — a file swapped on disk is not the approved asset.
  const onDisk = crypto.createHash('sha256').update(bytes).digest('hex');
  if (onDisk !== asset.sha256) return { ok: false, reason: 'file on disk no longer matches the governed asset fingerprint' };

  const up = await meta.uploadImage({ account, bytesBase64: bytes.toString('base64'), filename: asset.filename }, runner);
  if (!up.ok) return up;
  await runner.query(
    `INSERT INTO marketing_provider_images (provider, account_ref, production_creative_id, asset_sha256, provider_image_hash, provider_url)
     VALUES ('meta',$1,$2,$3,$4,$5)
     ON CONFLICT (provider, account_ref, asset_sha256) DO NOTHING`,
    [account, asset.id, asset.sha256, up.image_hash, up.url || null]);
  return { ok: true, image_hash: up.image_hash, reused: false };
}

/** Record a provider object under a deterministic key, so a retry reconciles instead of duplicating. */
async function rememberObject({ objectType, providerId, parentProviderId = null, campaignKey = null,
  experimentArmId = null, packageKey = null, account, idempotencyKey, providerStatus = 'PAUSED',
  certification = false, evidence = {}, runner = db }) {
  await runner.query(
    `INSERT INTO marketing_provider_objects
       (provider, account_ref, object_type, provider_id, parent_provider_id, campaign_key,
        experiment_arm_id, package_key, idempotency_key, provider_status, intended_status,
        certification_artifact, evidence)
     VALUES ('meta',$1,$2,$3,$4,$5,$6,$7,$8,$9,'PAUSED',$10,$11::jsonb)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       provider_id=EXCLUDED.provider_id, provider_status=EXCLUDED.provider_status,
       parent_provider_id=EXCLUDED.parent_provider_id, evidence=EXCLUDED.evidence,
       last_reconciled_at=now()`,
    [account, objectType, providerId, parentProviderId, campaignKey, experimentArmId, packageKey,
     idempotencyKey, providerStatus, certification, JSON.stringify(evidence)]);
}

/** An existing provider object for this key, if we already made one. */
async function findObject(idempotencyKey, runner = db) {
  return (await runner.query(
    'SELECT * FROM marketing_provider_objects WHERE idempotency_key = $1', [idempotencyKey])).rows[0] || null;
}

async function identities() {
  const [page, ig, pixel] = await Promise.all([
    configService.get(null, 'marketing.meta.page_id'),
    configService.get(null, 'marketing.meta.instagram_id'),
    configService.get(null, 'marketing.meta.pixel_id'),
  ]);
  return { pageId: page, instagramId: ig, pixelId: pixel };
}

const buildModeOn = async () => (await configService.get(null, 'marketing.paid.build_mode')) === true;

/**
 * Validate the ENTIRE chain against the real account without creating anything that can deliver.
 * Campaign and creative validate standalone; ad set and ad need real parent ids, so the caller
 * supplies them (from minimum PAUSED certification artifacts).
 */
async function validateChain({ account, campaignId = null, adsetId = null, creativeId = null,
  imageHash, targetingSpec, pkg, dailyBudgetCents = 5000, funnel, runner = db } = {}) {
  const ids = await identities();
  const out = {};

  out.campaign = await meta.validateObject('campaigns', meta.buildCampaignBody({
    name: 'ADV — chain validation', funnel, spendCapCents: 13500 }), { account }, runner);

  out.adcreative = await meta.validateObject('adcreatives', meta.buildCreativeBody({
    name: 'ADV — chain validation creative', pageId: ids.pageId, instagramId: ids.instagramId,
    imageHash, message: pkg.primary_text, headline: pkg.headline, description: pkg.description,
    destinationUrl: pkg.destination_url, ctaType: pkg.cta_type }), { account }, runner);

  out.adset = campaignId
    ? await meta.validateObject('adsets', meta.buildAdSetBody({
        name: 'ADV — chain validation adset', campaignId, dailyBudgetCents,
        targetingSpec, pixelId: ids.pixelId }), { account }, runner)
    : { ok: false, reason: 'ad set validation needs a real campaign id' };

  out.ad = (adsetId && creativeId)
    ? await meta.validateObject('ads', meta.buildAdBody({
        name: 'ADV — chain validation ad', adsetId, creativeId }), { account }, runner)
    : { ok: false, reason: 'ad validation needs real ad set and creative ids' };

  out.all_valid = ['campaign', 'adcreative', 'adset', 'ad'].every((k) => out[k] && out[k].ok);
  return out;
}

/**
 * Compare what we intended with what Meta actually holds.
 * Reports drift rather than silently repairing it: a surprise at the provider is information.
 */
async function reconcile({ account, runner = db } = {}) {
  const rows = (await runner.query(
    `SELECT * FROM marketing_provider_objects WHERE provider='meta' AND account_ref=$1 AND provider_id IS NOT NULL
      ORDER BY created_at`, [account])).rows;
  const report = [];
  for (const o of rows) {
    const got = await meta.getObject(o.object_type, o.provider_id);
    if (!got.ok) {
      report.push({ object_type: o.object_type, provider_id: o.provider_id, present: false, drift: got.reason });
      await runner.query('UPDATE marketing_provider_objects SET last_error=$2, last_reconciled_at=now() WHERE id=$1',
        [o.id, String(got.reason).slice(0, 300)]);
      continue;
    }
    const status = got.object.status || got.object.effective_status || null;
    const drift = status && o.intended_status && status !== o.intended_status
      ? 'provider status ' + status + ' but intended ' + o.intended_status : null;
    report.push({ object_type: o.object_type, provider_id: o.provider_id, present: true, status, drift,
      certification_artifact: o.certification_artifact });
    await runner.query(
      'UPDATE marketing_provider_objects SET provider_status=$2, last_reconciled_at=now(), last_error=NULL WHERE id=$1',
      [o.id, status]);
  }
  return { ok: true, objects: report, drifted: report.filter((r) => r.drift || !r.present) };
}

/**
 * The global kill, extended across every delivery object we know about: ad → ad set → campaign.
 * Best effort per object so one provider failure cannot strand the rest, and every failure is
 * surfaced rather than swallowed.
 */
async function killAllDeliveryObjects({ account, reason = 'owner emergency stop', runner = db } = {}) {
  const order = ['ad', 'adset', 'campaign'];
  const results = [];
  for (const type of order) {
    const rows = (await runner.query(
      `SELECT id, provider_id, object_type FROM marketing_provider_objects
        WHERE provider='meta' AND account_ref=$1 AND object_type=$2 AND provider_id IS NOT NULL`,
      [account, type])).rows;
    for (const o of rows) {
      const r = await meta.pause(o.provider_id, runner).catch((e) => ({ ok: false, reason: e.message }));
      results.push({ object_type: type, provider_id: o.provider_id, paused: r.ok, reason: r.reason || null });
      await runner.query(
        `UPDATE marketing_provider_objects SET provider_status=$2, last_error=$3, last_reconciled_at=now() WHERE id=$1`,
        [o.id, r.ok ? 'PAUSED' : null, r.ok ? null : String(r.reason).slice(0, 300)]);
    }
  }
  return { ok: true, paused: results.filter((r) => r.paused).length, failed: results.filter((r) => !r.paused), results, reason };
}

/** Provider-reported performance for our objects. Nothing is synthesised. */
async function readPerformance({ account, level = 'ad', since = null, until = null, runner = db } = {}) {
  const r = await meta.insights({ account, level, since, until }, runner);
  if (!r.ok) return r;
  return { ok: true, level, rows: r.rows.map((x) => ({
    campaign_id: x.campaign_id || null, adset_id: x.adset_id || null, ad_id: x.ad_id || null,
    spend_cents: x.spend != null ? Math.round(Number(x.spend) * 100) : null,
    impressions: x.impressions != null ? Number(x.impressions) : null,
    clicks: x.clicks != null ? Number(x.clicks) : null,
    link_clicks: x.inline_link_clicks != null ? Number(x.inline_link_clicks) : null,
    actions: x.actions || null,
  })) };
}


/**
 * Build the COMPLETE Meta hierarchy for one authorized audience experiment, entirely PAUSED.
 *
 *   campaign (spend_cap = the campaign's authorized total)
 *     ad set per experiment arm (daily_budget = the arm's share of the daily ceiling)
 *       creative (governed package)
 *         ad
 *
 * BUDGET CANNOT BE MULTIPLIED HERE. The campaign's provider spend cap is the authorized total, and
 * the ad sets' daily budgets are a share of the PLATFORM daily ceiling divided across every arm
 * being built — adding arms divides the same money rather than requesting more. Anything that would
 * exceed the authorization refuses before a single provider call.
 *
 * Idempotent: every object is keyed, so a retry re-uses what exists instead of creating a second.
 */
async function buildExperimentHierarchy({ experimentKey, account, dailyCeilingCentsForExperiment,
  packageKeyByArm, dryRun = false, runner = db, lifetimeSchedule = null, customEventType = null } = {}) {
  // lifetimeSchedule = { startTime, endTime } — each arm gets a LIFETIME budget equal to its allocation
  // (a hard provider-side total) instead of a daily pacing target. Used when the authorization is below
  // Meta's $100 minimum campaign spend cap, so the campaign itself cannot carry the cap.
  const exp = (await runner.query(
    `SELECT e.*, c.funnel AS campaign_funnel, c.budget_cents AS campaign_budget_cents, c.destination_url
       FROM marketing_audience_experiments e
       JOIN marketing_paid_campaigns c ON c.campaign_key = e.campaign_key
      WHERE e.experiment_key = $1`, [experimentKey])).rows[0];
  if (!exp) return { ok: false, reason: 'unknown experiment ' + experimentKey };

  const arms = (await runner.query(
    `SELECT a.id, a.arm_label, a.allocated_cents, a.provider_adset_id, s.strategy_key, s.targeting_spec,
            s.validation_state, s.policy_status, s.optimization_goal, s.funnel AS strategy_funnel
       FROM marketing_audience_experiment_arms a
       JOIN marketing_audience_strategies s ON s.id = a.strategy_id
      WHERE a.experiment_id = $1 ORDER BY a.arm_label`, [exp.id])).rows;
  if (!arms.length) return { ok: false, reason: 'experiment has no arms' };

  // Every arm must still be provider-validated and policy clean at the moment of building.
  for (const a of arms) {
    if (a.validation_state !== 'VALID') return { ok: false, reason: 'arm ' + a.arm_label + ' strategy is ' + a.validation_state };
    if (a.policy_status !== 'OK') return { ok: false, reason: 'arm ' + a.arm_label + ' strategy is policy blocked' };
    if (a.strategy_funnel !== exp.funnel) return { ok: false, reason: 'arm ' + a.arm_label + ' is for the wrong funnel' };
  }

  // The arms share the campaign's authorized total. This is the multiplication guard.
  const allocated = arms.reduce((t, a) => t + Number(a.allocated_cents), 0);
  if (allocated > Number(exp.campaign_budget_cents)) {
    return { ok: false, reason: `arms allocate $${(allocated / 100).toFixed(2)} but the campaign is authorized for $${(exp.campaign_budget_cents / 100).toFixed(2)}` };
  }
  // Daily budget per arm is a share of the daily ceiling apportioned to this experiment.
  let perArmDaily = Math.floor(Number(dailyCeilingCentsForExperiment) / arms.length);
  if (lifetimeSchedule) {
    const start = new Date(lifetimeSchedule.startTime).getTime();
    const end = new Date(lifetimeSchedule.endTime).getTime();
    if (!(end > start)) return { ok: false, reason: 'a lifetime budget needs an end time after its start' };
    if (arms.some((a) => !(Number(a.allocated_cents) > 0))) return { ok: false, reason: 'a lifetime-budget arm needs a positive allocation' };
    // The daily EQUIVALENT is what pacing governance compares against the safe daily target.
    const days = Math.max(1, (end - start) / 86400000);
    perArmDaily = Math.ceil(Math.max(...arms.map((a) => Number(a.allocated_cents))) / days);
  }
  if (!(perArmDaily > 0)) return { ok: false, reason: 'daily ceiling leaves nothing per arm' };

  // A daily budget is a pacing TARGET the provider may exceed on a single day, so the configured total
  // must sit under the safe pace for the rest of the month (after the safety factor). The monthly
  // ceiling wins over any nominal daily figure.
  let pacing = null;
  if (!dryRun) {
    const governance = require('./paidSpendGovernance');
    const allowed = await governance.assertNewSpendAllowed({ campaignKey: exp.campaign_key, action: 'build_experiment' });
    if (!allowed.ok) return { ok: false, reason: 'spend governance refused: ' + allowed.reason };
    const ov = await governance.overview();
    pacing = ov.position;
    const otherActive = ov.campaigns.filter((c) => c.state === 'ACTIVE' && c.campaign_key !== exp.campaign_key)
      .reduce((t, c) => t + (c.configured_daily_budget_cents || 0), 0);
    if (pacing && otherActive + perArmDaily * arms.length > pacing.recommended_max_daily_budget_cents) {
      return { ok: false, reason: `daily budgets would total $${((otherActive + perArmDaily * arms.length) / 100).toFixed(2)} but the recommended maximum for the rest of the month is $${(pacing.recommended_max_daily_budget_cents / 100).toFixed(2)} (safe pace $${(pacing.safe_daily_pacing_target_cents / 100).toFixed(2)} × safety factor ${pacing.safety_factor})` };
    }
  }

  const ids = await identities();
  const plan = {
    experiment_key: experimentKey, campaign_key: exp.campaign_key, funnel: exp.funnel,
    campaign_spend_cap_cents: Number(exp.campaign_budget_cents),
    arms: arms.map((a) => ({ arm: a.arm_label, strategy: a.strategy_key, allocated_cents: Number(a.allocated_cents),
      daily_budget_cents: perArmDaily, package_key: packageKeyByArm[a.arm_label] })),
    total_daily_cents: perArmDaily * arms.length,
  };
  if (dryRun) return { ok: true, dry_run: true, plan };

  // ── campaign ──
  const campKey = 'live:campaign:' + exp.campaign_key;
  let campaignId = (await findObject(campKey, runner) || {}).provider_id || null;
  if (!campaignId) {
    const r = await meta.createCampaign({ account, name: 'ADV — ' + exp.campaign_key, funnel: exp.funnel,
      spendCapCents: Number(exp.campaign_budget_cents), idempotencyKey: campKey }, runner);
    if (!r.ok) return { ok: false, reason: 'campaign: ' + r.reason };
    campaignId = r.provider_campaign_id;
    await rememberObject({ objectType: 'campaign', providerId: campaignId, account, campaignKey: exp.campaign_key,
      idempotencyKey: campKey, evidence: { spend_cap_cents: Number(exp.campaign_budget_cents) }, runner });
    await runner.query(
      `UPDATE marketing_paid_campaigns SET provider_account_ref=$2, provider_campaign_id=$3, state='READY', updated_at=now()
        WHERE campaign_key=$1`, [exp.campaign_key, account, campaignId]);
  }

  const built = { campaign_id: campaignId, arms: [] };

  for (const a of arms) {
    const packageKey = packageKeyByArm[a.arm_label];
    if (!packageKey) return { ok: false, reason: 'no creative package assigned to arm ' + a.arm_label };
    const pkg = (await runner.query(
      `SELECT p.*, c.id AS asset_id, c.sha256 AS asset_sha256, c.filename, c.production_eligible
         FROM marketing_creative_packages p
         JOIN marketing_production_creative c ON c.id = p.production_creative_id
        WHERE p.package_key = $1`, [packageKey])).rows[0];
    if (!pkg) return { ok: false, reason: 'unknown package ' + packageKey };
    if (pkg.approval_state !== 'OWNER_APPROVED' || pkg.policy_status !== 'OK' || pkg.active !== true) {
      return { ok: false, reason: 'package ' + packageKey + ' is not an approved, policy-clean, active package' };
    }
    if (pkg.production_eligible !== true) return { ok: false, reason: 'package ' + packageKey + ' image is not production-eligible' };
    if (pkg.funnel !== exp.funnel) return { ok: false, reason: 'package ' + packageKey + ' is for the wrong funnel' };
    // An Owner approval may be SCOPED — to named campaigns and a maximum authorization. Outside that
    // scope the package is not approved, whatever its approval_state says.
    const scope = pkg.approval_scope || null;
    if (scope && Array.isArray(scope.campaign_keys) && !scope.campaign_keys.includes(exp.campaign_key)) {
      return { ok: false, reason: 'package ' + packageKey + ' is approved only for ' + scope.campaign_keys.join(', ') };
    }
    if (scope && scope.max_authorization_cents != null && Number(exp.campaign_budget_cents) > Number(scope.max_authorization_cents)) {
      return { ok: false, reason: `package ${packageKey} is approved only up to $${(scope.max_authorization_cents / 100).toFixed(2)}` };
    }

    // ── image (uploaded once, reused) ──
    const img = await ensureImage({ productionCreativeId: pkg.asset_id, account, runner });
    if (!img.ok) return { ok: false, reason: 'image for ' + packageKey + ': ' + img.reason };

    // ── ad set ──
    const adsetKey = 'live:adset:' + experimentKey + ':' + a.arm_label;
    let adsetId = (await findObject(adsetKey, runner) || {}).provider_id || null;
    if (!adsetId) {
      const r = await meta.createAdSet({ account, name: 'ADV — ' + experimentKey + ' — ' + a.arm_label + ' (' + a.strategy_key + ')',
        campaignId, dailyBudgetCents: perArmDaily, targetingSpec: a.targeting_spec, pixelId: ids.pixelId,
        optimizationGoal: a.optimization_goal || 'OFFSITE_CONVERSIONS', customEventType: customEventType || undefined,
        ...(lifetimeSchedule ? { lifetimeBudgetCents: Number(a.allocated_cents), startTime: lifetimeSchedule.startTime, endTime: lifetimeSchedule.endTime } : {}) }, runner);
      if (!r.ok) return { ok: false, reason: 'ad set ' + a.arm_label + ': ' + r.reason };
      adsetId = r.provider_adset_id;
      await rememberObject({ objectType: 'adset', providerId: adsetId, parentProviderId: campaignId, account,
        campaignKey: exp.campaign_key, experimentArmId: a.id, idempotencyKey: adsetKey,
        evidence: lifetimeSchedule
          ? { strategy: a.strategy_key, lifetime_budget_cents: Number(a.allocated_cents), start_time: lifetimeSchedule.startTime, end_time: lifetimeSchedule.endTime, daily_equivalent_cents: perArmDaily }
          : { strategy: a.strategy_key, daily_budget_cents: perArmDaily }, runner });
      await runner.query('UPDATE marketing_audience_experiment_arms SET provider_adset_id=$2 WHERE id=$1', [a.id, adsetId]);
    }

    // ── creative ──
    const destination = buildDestination({
      destinationUrl: pkg.destination_url, funnel: exp.funnel, campaignKey: exp.campaign_key,
      strategyKey: a.strategy_key, experimentKey, armLabel: a.arm_label, packageKey });
    const creativeKey = 'live:creative:' + experimentKey + ':' + a.arm_label + ':' + packageKey + ':v' + pkg.version;
    let creativeId = (await findObject(creativeKey, runner) || {}).provider_id || null;
    if (!creativeId) {
      const r = await meta.createAdCreative({ account, name: 'ADV — ' + packageKey + ' v' + pkg.version + ' — ' + a.arm_label,
        pageId: ids.pageId, instagramId: ids.instagramId, imageHash: img.image_hash,
        message: pkg.primary_text, headline: pkg.headline, description: pkg.description,
        destinationUrl: destination, ctaType: pkg.cta_type }, runner);
      if (!r.ok) return { ok: false, reason: 'creative ' + packageKey + ': ' + r.reason };
      creativeId = r.provider_creative_id;
      await rememberObject({ objectType: 'adcreative', providerId: creativeId, account, campaignKey: exp.campaign_key,
        experimentArmId: a.id, packageKey, idempotencyKey: creativeKey,
        evidence: { image_hash: img.image_hash, destination, fingerprint: pkg.fingerprint, version: pkg.version }, runner });
    }

    // ── ad ──
    const adKey = 'live:ad:' + experimentKey + ':' + a.arm_label;
    let adId = (await findObject(adKey, runner) || {}).provider_id || null;
    if (!adId) {
      const r = await meta.createAd({ account, name: 'ADV — ' + experimentKey + ' — ' + a.arm_label,
        adsetId, creativeId }, runner);
      if (!r.ok) return { ok: false, reason: 'ad ' + a.arm_label + ': ' + r.reason };
      adId = r.provider_ad_id;
      await rememberObject({ objectType: 'ad', providerId: adId, parentProviderId: adsetId, account,
        campaignKey: exp.campaign_key, experimentArmId: a.id, packageKey, idempotencyKey: adKey, runner });
    }

    built.arms.push({ arm: a.arm_label, strategy: a.strategy_key, package_key: packageKey,
      adset_id: adsetId, creative_id: creativeId, ad_id: adId, image_hash: img.image_hash,
      daily_budget_cents: perArmDaily, destination });
  }
  return { ok: true, plan, built };
}

/**
 * Flip the built hierarchy from PAUSED to ACTIVE, ads first so nothing can deliver before its
 * parents are ready. Refuses entirely while build mode or the global kill is on (enforced again in
 * the provider), and refuses if the campaign's provider spend cap does not match its authorization.
 */
async function activateExperiment({ experimentKey, account, runner = db } = {}) {
  if (await buildModeOn()) return { ok: false, reason: 'build mode is ON — activation refused' };

  const exp = (await runner.query(
    'SELECT campaign_key FROM marketing_audience_experiments WHERE experiment_key = $1', [experimentKey])).rows[0];
  if (!exp) return { ok: false, reason: 'unknown experiment ' + experimentKey };

  // Activation adds paid delivery: fresh spend, a safe reconciliation and a launched market first.
  const allowed = await require('./paidSpendGovernance').assertNewSpendAllowed({ campaignKey: exp.campaign_key, action: 'activate_experiment' });
  if (!allowed.ok) return { ok: false, reason: 'spend governance refused: ' + allowed.reason };

  // Ads first, then ad sets, then the campaign: a parent that turns on before its children cannot
  // deliver anything, whereas the reverse order could briefly leave an orphan live.
  const rows = (await runner.query(
    `SELECT object_type, provider_id FROM marketing_provider_objects
      WHERE account_ref = $1 AND campaign_key = $2 AND provider_id IS NOT NULL
        AND certification_artifact = false AND object_type IN ('ad','adset','campaign')
      ORDER BY CASE object_type WHEN 'ad' THEN 1 WHEN 'adset' THEN 2 ELSE 3 END`,
    [account, exp.campaign_key])).rows;
  if (!rows.length) return { ok: false, reason: 'no provider objects to activate for ' + experimentKey };

  const results = [];
  for (const o of rows) {
    const r = await meta.setStatus({ objectId: o.provider_id, status: 'ACTIVE' }, runner);
    results.push({ object_type: o.object_type, provider_id: o.provider_id, activated: r.ok, reason: r.reason || null });
    if (r.ok) {
      await runner.query(
        `UPDATE marketing_provider_objects SET provider_status='ACTIVE', intended_status='ACTIVE',
            last_reconciled_at=now() WHERE provider_id=$1`, [o.provider_id]);
    }
  }
  const ok = results.every((r) => r.activated);
  if (ok) {
    await runner.query(
      `UPDATE marketing_paid_campaigns SET state='ACTIVE', activated_at=now(), updated_at=now() WHERE campaign_key=$1`,
      [exp.campaign_key]);
    await runner.query(
      `UPDATE marketing_audience_experiments SET state='RUNNING', updated_at=now() WHERE experiment_key=$1`, [experimentKey]);
  }
  return { ok, results };
}

module.exports = {
  buildDestination, packageFingerprint, ensureImage, rememberObject, findObject, identities,
  buildModeOn, validateChain, reconcile, killAllDeliveryObjects, readPerformance,
  buildExperimentHierarchy, activateExperiment,
};
