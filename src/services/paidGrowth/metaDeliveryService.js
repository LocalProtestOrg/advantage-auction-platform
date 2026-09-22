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

module.exports = {
  buildDestination, packageFingerprint, ensureImage, rememberObject, findObject, identities,
  buildModeOn, validateChain, reconcile, killAllDeliveryObjects, readPerformance,
};
