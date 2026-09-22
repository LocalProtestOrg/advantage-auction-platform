#!/usr/bin/env node
/* certify-meta-chain.js — proves Meta accepts the COMPLETE delivery chain for Advantage.Bid,
   without serving a single impression.

   Campaign and creative validate standalone with execution_options=['validate_only']. Ad sets and
   ads cannot: Meta requires a real parent id before it will validate them. So this creates the
   MINIMUM set of PAUSED certification artifacts needed to obtain those ids, validates against them,
   reads every object back, and then deletes the artifacts.

   Governed uploaded images are deliberately KEPT: an ad image is inert on its own (it cannot
   deliver, cost anything or be seen) and reusing it avoids re-uploading the same approved bytes.

   Nothing is ever set ACTIVE. Every object is created PAUSED, the campaign carries a spend cap, and
   the ad set carries a daily budget that never runs because nothing is active. Certification
   artifacts are marked as such in marketing_provider_objects and removed at the end.

   Usage: node scripts/certify-meta-chain.js [--keep]   (--keep leaves artifacts for inspection) */

const db = require('../src/db');
const meta = require('../src/services/paidGrowth/metaAdsProvider');
const delivery = require('../src/services/paidGrowth/metaDeliveryService');

const KEEP = process.argv.includes('--keep');
const STRATEGY = (process.argv.find((a) => a.startsWith('--strategy=')) || '').split('=')[1] || null;
const PACKAGE = (process.argv.find((a) => a.startsWith('--package=')) || '').split('=')[1] || null;
const FUNNEL = (process.argv.find((a) => a.startsWith('--funnel=')) || '').split('=')[1] || null;
const log = (...a) => console.log(...a);

(async () => {
  const acct = await meta.resolveAdAccount();
  if (!acct.ok) { console.error('REFUSE: ' + acct.reason); return 2; }
  const account = acct.account;
  log('Account: ' + account + ' "' + acct.name + '"');

  const perms = await meta.permissions();
  if (!perms.ads_management) { console.error('REFUSE: ads_management not granted'); return 2; }

  // Build mode must be on: this script must never be able to activate anything.
  if (!(await delivery.buildModeOn())) { console.error('REFUSE: build mode is off'); return 2; }

  const pkg = (await db.query(
    `SELECT p.*, c.sha256 AS asset_sha256, c.id AS asset_id, c.filename
       FROM marketing_creative_packages p
       JOIN marketing_production_creative c ON c.id = p.production_creative_id
      WHERE p.approval_state='OWNER_APPROVED' AND p.policy_status='OK'
        AND ($1::text IS NULL OR p.package_key = $1)
        AND ($2::text IS NULL OR p.funnel = $2)
      ORDER BY p.created_at LIMIT 1`, [PACKAGE, PACKAGE ? null : (FUNNEL || 'individual_seller')])).rows[0];
  if (!pkg) { console.error('REFUSE: no Owner-approved creative package matching the request'); return 2; }
  log('Package: ' + pkg.package_key + '  image=' + pkg.filename);

  const strategy = (await db.query(
    `SELECT strategy_key, targeting_spec FROM marketing_audience_strategies
      WHERE funnel = $2 AND validation_state='VALID' AND policy_status='OK'
        AND ($1::text IS NULL OR strategy_key = $1)
      ORDER BY strategy_key LIMIT 1`, [STRATEGY, pkg.funnel])).rows[0];
  if (!strategy) { console.error('REFUSE: no VALID ' + pkg.funnel + ' audience strategy'); return 2; }
  log('Strategy: ' + strategy.strategy_key);

  // 1. Image — a real upload, reused thereafter. An image serves nothing on its own.
  const img = await delivery.ensureImage({ productionCreativeId: pkg.asset_id, account });
  if (!img.ok) { console.error('IMAGE FAILED: ' + img.reason); return 1; }
  log('\n1. IMAGE      ok  hash=' + img.image_hash.slice(0, 16) + '…  reused=' + img.reused);

  const destination = delivery.buildDestination({
    destinationUrl: pkg.destination_url, funnel: pkg.funnel, campaignKey: 'CERT',
    strategyKey: strategy.strategy_key, experimentKey: 'CERT', armLabel: 'CERT', packageKey: pkg.package_key });
  const copy = Object.assign({}, pkg, { destination_url: destination });

  // 2. Campaign + creative validate standalone.
  const pre = await delivery.validateChain({ account, imageHash: img.image_hash,
    targetingSpec: strategy.targeting_spec, pkg: copy, funnel: pkg.funnel });
  log('2. CAMPAIGN   validate_only ' + (pre.campaign.ok ? 'ok' : 'FAILED: ' + pre.campaign.reason));
  log('3. CREATIVE   validate_only ' + (pre.adcreative.ok ? 'ok' : 'FAILED: ' + pre.adcreative.reason));
  if (!pre.campaign.ok || !pre.adcreative.ok) return 1;

  // 3. Minimum PAUSED artifacts so ad set and ad can be validated against real parents.
  const artifacts = [];
  const stamp = Date.now();
  const camp = await meta.createCampaign({ account, name: 'ADV — CERTIFICATION (do not activate) ' + stamp,
    funnel: pkg.funnel, spendCapCents: 13500, idempotencyKey: 'cert:campaign:' + stamp }, db);
  if (!camp.ok) { console.error('CERT CAMPAIGN FAILED: ' + camp.reason); return 1; }
  artifacts.push({ type: 'campaign', id: camp.provider_campaign_id });
  await delivery.rememberObject({ objectType: 'campaign', providerId: camp.provider_campaign_id, account,
    idempotencyKey: 'cert:campaign:' + stamp, certification: true, evidence: { purpose: 'chain certification' } });
  log('4. CAMPAIGN   created PAUSED  id=' + camp.provider_campaign_id);

  const withCampaign = await delivery.validateChain({ account, campaignId: camp.provider_campaign_id,
    imageHash: img.image_hash, targetingSpec: strategy.targeting_spec, pkg: copy, funnel: pkg.funnel });
  log('5. AD SET     validate_only ' + (withCampaign.adset.ok ? 'ok' : 'FAILED: ' + withCampaign.adset.reason));
  if (!withCampaign.adset.ok) { await cleanup(artifacts); return 1; }

  const adset = await meta.createAdSet({ account, name: 'ADV — CERTIFICATION adset ' + stamp,
    campaignId: camp.provider_campaign_id, dailyBudgetCents: 5000,
    targetingSpec: strategy.targeting_spec, pixelId: (await delivery.identities()).pixelId }, db);
  if (!adset.ok) { console.error('CERT AD SET FAILED: ' + adset.reason); await cleanup(artifacts); return 1; }
  artifacts.push({ type: 'adset', id: adset.provider_adset_id });
  await delivery.rememberObject({ objectType: 'adset', providerId: adset.provider_adset_id,
    parentProviderId: camp.provider_campaign_id, account, idempotencyKey: 'cert:adset:' + stamp, certification: true });
  log('6. AD SET     created PAUSED  id=' + adset.provider_adset_id);

  const ids = await delivery.identities();
  const creative = await meta.createAdCreative({ account, name: 'ADV — CERTIFICATION creative ' + stamp,
    pageId: ids.pageId, instagramId: ids.instagramId, imageHash: img.image_hash,
    message: copy.primary_text, headline: copy.headline, description: copy.description,
    destinationUrl: destination, ctaType: copy.cta_type }, db);
  if (!creative.ok) { console.error('CERT CREATIVE FAILED: ' + creative.reason); await cleanup(artifacts); return 1; }
  artifacts.push({ type: 'adcreative', id: creative.provider_creative_id });
  await delivery.rememberObject({ objectType: 'adcreative', providerId: creative.provider_creative_id,
    account, packageKey: pkg.package_key, idempotencyKey: 'cert:creative:' + stamp, certification: true });
  log('7. CREATIVE   created        id=' + creative.provider_creative_id);

  const withAll = await delivery.validateChain({ account, campaignId: camp.provider_campaign_id,
    adsetId: adset.provider_adset_id, creativeId: creative.provider_creative_id,
    imageHash: img.image_hash, targetingSpec: strategy.targeting_spec, pkg: copy, funnel: pkg.funnel });
  log('8. AD         validate_only ' + (withAll.ad.ok ? 'ok' : 'FAILED: ' + withAll.ad.reason));
  if (!withAll.ad.ok) { await cleanup(artifacts); return 1; }

  const ad = await meta.createAd({ account, name: 'ADV — CERTIFICATION ad ' + stamp,
    adsetId: adset.provider_adset_id, creativeId: creative.provider_creative_id }, db);
  if (!ad.ok) { console.error('CERT AD FAILED: ' + ad.reason); await cleanup(artifacts); return 1; }
  artifacts.push({ type: 'ad', id: ad.provider_ad_id });
  await delivery.rememberObject({ objectType: 'ad', providerId: ad.provider_ad_id,
    parentProviderId: adset.provider_adset_id, account, packageKey: pkg.package_key,
    idempotencyKey: 'cert:ad:' + stamp, certification: true });
  log('9. AD         created PAUSED  id=' + ad.provider_ad_id);

  // 4. Read every object back and prove the relationships and the non-delivering status.
  log('\nREADBACK:');
  let allPaused = true;
  for (const a of artifacts) {
    const got = await meta.getObject(a.type, a.id);
    if (!got.ok) { log('  ' + a.type.padEnd(11) + 'READ FAILED: ' + got.reason); allPaused = false; continue; }
    const o = got.object;
    const status = o.status || o.effective_status || '(n/a)';
    if (a.type !== 'adcreative' && status !== 'PAUSED') allPaused = false;
    log('  ' + a.type.padEnd(11) + 'status=' + String(status).padEnd(10)
      + (o.campaign_id ? 'campaign=' + o.campaign_id + ' ' : '')
      + (o.adset_id ? 'adset=' + o.adset_id + ' ' : '')
      + (o.creative ? 'creative=' + o.creative.id + ' ' : '')
      + (o.daily_budget ? 'daily=$' + (Number(o.daily_budget) / 100).toFixed(2) + ' ' : '')
      + (o.optimization_goal || ''));
    if (a.type === 'adset' && o.targeting) {
      const t = o.targeting;
      const city = (t.geo_locations && t.geo_locations.cities && t.geo_locations.cities[0]) || {};
      log('               geo=' + (city.key || '?') + ' radius=' + (city.radius || '?')
        + '  age_min=' + (t.age_min || '?') + '  interests='
        + JSON.stringify(((t.flexible_spec || [])[0] || {}).interests || []).slice(0, 90));
    }
    if (a.type === 'adcreative' && o.object_story_spec) {
      const ld = o.object_story_spec.link_data || {};
      log('               page=' + o.object_story_spec.page_id + '  link=' + String(ld.link || '').slice(0, 96));
    }
  }
  log('\nALL DELIVERY OBJECTS PAUSED: ' + allPaused);

  const spend = await delivery.readPerformance({ account, level: 'ad' });
  log('SPEND READBACK: ' + (spend.ok ? JSON.stringify(spend.rows) : spend.reason) + '  (empty = nothing delivered)');

  const rec = await delivery.reconcile({ account });
  log('RECONCILE: ' + rec.objects.length + ' objects tracked, drifted=' + rec.drifted.length);

  if (KEEP) { log('\n--keep: certification artifacts retained.'); return 0; }
  await cleanup(artifacts);
  const left = await meta.listCampaigns({ account });
  log('CAMPAIGNS REMAINING AT PROVIDER: ' + (left.ok ? left.campaigns.length : 'err'));
  log('\nRESULT: PASS — the complete chain is provider-valid and nothing was left delivering.');
  return 0;
})().then((c) => process.exit(c || 0)).catch((e) => { console.error(e); process.exit(1); });

/** Remove certification artifacts, children first. */
async function cleanup(artifacts) {
  console.log('\nCLEANUP:');
  for (const a of artifacts.slice().reverse()) {
    const d = await meta.deleteObject(a.id);
    console.log('  ' + a.type.padEnd(11) + (d.ok ? 'deleted' : 'DELETE FAILED: ' + d.reason) + '  ' + a.id);
    await db.query(`DELETE FROM marketing_provider_objects WHERE provider_id=$1 AND certification_artifact=true`, [a.id]);
  }
}
