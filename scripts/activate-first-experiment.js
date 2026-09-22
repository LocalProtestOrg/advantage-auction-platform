#!/usr/bin/env node
/* activate-first-experiment.js — the first real paid seller acquisition experiment.
   Deliberately phased so that nothing can deliver before it has been independently verified.

     --plan        show exactly what would be built. Touches no provider.
     --create      build the full hierarchy PAUSED at Meta.
     --verify      read every object BACK from Meta and check it against the authorization.
     --activate    flip PAUSED -> ACTIVE. Refuses unless --verify would pass.

   The verification compares the provider's own answers with the Owner's authorization — account,
   funnel, geography, audience, age floor, creative, destination, attribution, budgets and the
   parent/child relationships. Any material mismatch stops the run with delivery still paused. */

const db = require('../src/db');
const meta = require('../src/services/paidGrowth/metaAdsProvider');
const delivery = require('../src/services/paidGrowth/metaDeliveryService');
const ledger = require('../src/services/paidBudgetLedger');

const has = (f) => process.argv.includes('--' + f);
const log = (...a) => console.log(...a);

/** The Owner's authorization for this experiment, written out so it can be checked, not assumed. */
const AUTHORIZED = {
  daily_ceiling_cents: 5000,          // platform-wide, shared across every ad set built here
  combined_max_cents: 27000,
  geo_key: '2527622',                 // Houston, Texas
  min_age: 25,
  experiments: [
    {
      experiment_key: 'EXP-IS-HOU-2026-10',
      campaign_key: '2026-10-individual-seller-houston',
      funnel: 'individual_seller',
      max_cents: 13500,
      destination_prefix: 'https://bid.advantage.bid/become-seller.html',
      // One creative across both arms: this is an AUDIENCE test, so the creative is held constant.
      package_by_arm: { 'A-broad': 'PKG-IS-HOU-V1', 'B-intent': 'PKG-IS-HOU-V1' },
    },
    {
      experiment_key: 'EXP-PS-HOU-2026-10',
      campaign_key: '2026-10-professional-seller-houston',
      funnel: 'professional_seller',
      max_cents: 13500,
      destination_prefix: 'https://bid.advantage.bid/become-professional-seller.html',
      package_by_arm: { 'A-smb': 'PKG-PS-HOU-V1', 'B-broad': 'PKG-PS-HOU-V1' },
    },
  ],
  // Certified and registered, but NOT authorized for paid delivery in this first experiment.
  excluded_packages: ['PKG-PS-ESTATE-OPERATOR-V1', 'PKG-PS-AUCTIONHOUSE-V1'],
};

/** Half the platform daily ceiling per experiment, so both together never exceed it. */
const perExperimentDaily = () => Math.floor(AUTHORIZED.daily_ceiling_cents / AUTHORIZED.experiments.length);

async function resolveAccount() {
  const a = await meta.resolveAdAccount();
  if (!a.ok) { console.error('REFUSE: ' + a.reason); process.exit(2); }
  return a;
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────────

async function plan(account) {
  let total = 0;
  for (const e of AUTHORIZED.experiments) {
    const r = await delivery.buildExperimentHierarchy({
      experimentKey: e.experiment_key, account,
      dailyCeilingCentsForExperiment: perExperimentDaily(),
      packageKeyByArm: e.package_by_arm, dryRun: true });
    if (!r.ok) { console.error('PLAN FAILED (' + e.experiment_key + '): ' + r.reason); return false; }
    total += r.plan.campaign_spend_cap_cents;
    log('\n' + e.experiment_key + '  [' + e.funnel + ']');
    log('  campaign spend cap : $' + (r.plan.campaign_spend_cap_cents / 100).toFixed(2)
      + '   (authorized $' + (e.max_cents / 100).toFixed(2) + ')');
    log('  daily across arms  : $' + (r.plan.total_daily_cents / 100).toFixed(2));
    r.plan.arms.forEach((a) => log('    ' + a.arm.padEnd(10) + a.strategy.padEnd(18) + a.package_key.padEnd(18)
      + 'allocated $' + (a.allocated_cents / 100).toFixed(2) + '  daily $' + (a.daily_budget_cents / 100).toFixed(2)));
    if (r.plan.campaign_spend_cap_cents > e.max_cents) { console.error('  REFUSE: exceeds authorization'); return false; }
  }
  const dailyTotal = perExperimentDaily() * AUTHORIZED.experiments.length;
  log('\nCOMBINED: $' + (total / 100).toFixed(2) + ' of $' + (AUTHORIZED.combined_max_cents / 100).toFixed(2)
    + ' authorized   ·   daily $' + (dailyTotal / 100).toFixed(2) + ' of $' + (AUTHORIZED.daily_ceiling_cents / 100).toFixed(2));
  if (total > AUTHORIZED.combined_max_cents) { console.error('REFUSE: combined exceeds authorization'); return false; }
  if (dailyTotal > AUTHORIZED.daily_ceiling_cents) { console.error('REFUSE: combined daily exceeds the ceiling'); return false; }
  const b = await ledger.status();
  log('LEDGER: committed $' + (b.committed_cents / 100).toFixed(2) + '  actual $' + (b.actual_cents / 100).toFixed(2)
    + '  remaining $' + (b.remaining_cents / 100).toFixed(2) + ' of $' + (b.ceiling_cents / 100).toFixed(2));
  if (total > b.remaining_cents) { console.error('REFUSE: exceeds remaining monthly authority'); return false; }
  return true;
}

// ── create (paused) ───────────────────────────────────────────────────────────────────────────

async function create(account) {
  for (const e of AUTHORIZED.experiments) {
    // Reserve the money BEFORE the provider is called, exactly as the certified runtime does.
    const res = await ledger.reserve({ campaignKey: e.campaign_key, amountCents: e.max_cents,
      idempotencyKey: 'campaign:' + e.campaign_key, note: 'first controlled experiment' });
    if (!res.ok) { console.error('BUDGET REFUSED (' + e.campaign_key + '): ' + res.reason); return false; }
    log(e.campaign_key + ': reserved $' + (e.max_cents / 100).toFixed(2) + (res.replayed ? ' (replayed)' : ''));

    const r = await delivery.buildExperimentHierarchy({
      experimentKey: e.experiment_key, account,
      dailyCeilingCentsForExperiment: perExperimentDaily(),
      packageKeyByArm: e.package_by_arm });
    if (!r.ok) {
      console.error('BUILD FAILED (' + e.experiment_key + '): ' + r.reason);
      await ledger.release({ campaignKey: e.campaign_key, amountCents: e.max_cents,
        idempotencyKey: 'campaign:' + e.campaign_key + ':release', note: 'build failed' });
      return false;
    }
    log('  campaign ' + r.built.campaign_id);
    r.built.arms.forEach((a) => log('    ' + a.arm.padEnd(10) + 'adset=' + a.adset_id
      + '  creative=' + a.creative_id + '  ad=' + a.ad_id));
  }
  return true;
}

// ── verify against the provider's own answers ─────────────────────────────────────────────────

async function verify(account) {
  let allOk = true;
  const fail = (m) => { console.error('   MISMATCH: ' + m); allOk = false; };

  for (const e of AUTHORIZED.experiments) {
    log('\n' + e.experiment_key);
    const objs = (await db.query(
      `SELECT o.object_type, o.provider_id, o.parent_provider_id, o.package_key, o.evidence,
              a.arm_label, s.strategy_key
         FROM marketing_provider_objects o
         LEFT JOIN marketing_audience_experiment_arms a ON a.id = o.experiment_arm_id
         LEFT JOIN marketing_audience_strategies s ON s.id = a.strategy_id
        WHERE o.account_ref=$1 AND o.campaign_key=$2 AND o.certification_artifact=false
        ORDER BY o.object_type`, [account, e.campaign_key])).rows;
    if (!objs.length) { fail('no provider objects recorded'); continue; }

    const campaign = objs.find((o) => o.object_type === 'campaign');
    const adsets = objs.filter((o) => o.object_type === 'adset');
    const ads = objs.filter((o) => o.object_type === 'ad');
    const creatives = objs.filter((o) => o.object_type === 'adcreative');

    // Campaign
    const c = await meta.getObject('campaign', campaign.provider_id);
    if (!c.ok) { fail('campaign unreadable: ' + c.reason); continue; }
    log('  campaign ' + campaign.provider_id + '  status=' + c.object.status
      + '  spend_cap=$' + (Number(c.object.spend_cap || 0) / 100).toFixed(2) + '  objective=' + c.object.objective);
    if (Number(c.object.spend_cap) !== e.max_cents) fail('campaign spend cap is not the authorized amount');

    // Ad sets
    let dailyTotal = 0;
    for (const o of adsets) {
      const g = await meta.getObject('adset', o.provider_id);
      if (!g.ok) { fail('ad set unreadable: ' + g.reason); continue; }
      const t = g.object.targeting || {};
      const city = ((t.geo_locations || {}).cities || [])[0] || {};
      dailyTotal += Number(g.object.daily_budget || 0);
      log('  adset ' + o.provider_id + '  ' + (o.arm_label || '?') + '  status=' + g.object.status
        + '  daily=$' + (Number(g.object.daily_budget || 0) / 100).toFixed(2)
        + '  geo=' + city.key + '  radius=' + city.radius + '  age_min=' + t.age_min
        + '  goal=' + g.object.optimization_goal);
      if (String(city.key) !== AUTHORIZED.geo_key) fail('ad set geography is not Houston');
      if (Number(t.age_min) < AUTHORIZED.min_age) fail('ad set age floor is below the authorized minimum');
      if (String(g.object.campaign_id) !== String(campaign.provider_id)) fail('ad set is not under the authorized campaign');
      if (t.targeting_automation === undefined) fail('ad set does not state an Advantage+ audience decision');
    }
    if (dailyTotal > perExperimentDaily()) fail('ad set daily budgets exceed this experiment share of the daily ceiling');
    log('  daily across arms: $' + (dailyTotal / 100).toFixed(2) + ' of $' + (perExperimentDaily() / 100).toFixed(2));

    // Creatives
    for (const o of creatives) {
      const g = await meta.getObject('adcreative', o.provider_id);
      if (!g.ok) { fail('creative unreadable: ' + g.reason); continue; }
      const ld = ((g.object.object_story_spec || {}).link_data) || {};
      const url = new URL(ld.link || 'https://invalid.example');
      log('  creative ' + o.provider_id + '  pkg=' + o.package_key + '  page=' + (g.object.object_story_spec || {}).page_id);
      log('     link ' + String(ld.link || '').slice(0, 110));
      if (!String(ld.link || '').startsWith(e.destination_prefix)) fail('creative destination is not the canonical one');
      for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
        'adv_funnel', 'adv_experiment', 'adv_arm', 'adv_provider']) {
        if (!url.searchParams.get(k)) fail('creative link is missing attribution parameter ' + k);
      }
      if (url.searchParams.get('adv_funnel') !== e.funnel) fail('creative attribution names the wrong funnel');
      if (AUTHORIZED.excluded_packages.includes(o.package_key)) fail('EXCLUDED package is present: ' + o.package_key);
      if (!ld.image_hash) fail('creative carries no image');
    }

    // Ads
    for (const o of ads) {
      const g = await meta.getObject('ad', o.provider_id);
      if (!g.ok) { fail('ad unreadable: ' + g.reason); continue; }
      log('  ad ' + o.provider_id + '  status=' + g.object.status + '  adset=' + g.object.adset_id
        + '  creative=' + ((g.object.creative || {}).id));
      if (!adsets.some((x) => String(x.provider_id) === String(g.object.adset_id))) fail('ad is not under an authorized ad set');
      if (!creatives.some((x) => String(x.provider_id) === String((g.object.creative || {}).id))) fail('ad uses an unrecognised creative');
    }

    // No duplicates
    const live = await meta.listCampaigns({ account });
    const mine = live.ok ? live.campaigns.filter((x) => x.name && x.name.indexOf(e.campaign_key) !== -1) : [];
    if (mine.length > 1) fail('duplicate campaigns exist for ' + e.campaign_key);
  }

  // Excluded account untouched, and nothing unexpected is live.
  const guard = await meta.assertNotExcluded('act_664514018846795');
  if (guard.ok) fail('the excluded account is no longer refused');
  log('\nexcluded account refused: ' + (!guard.ok));
  return allOk;
}

// ── activate ──────────────────────────────────────────────────────────────────────────────────

async function activate(account) {
  for (const e of AUTHORIZED.experiments) {
    const r = await delivery.activateExperiment({ experimentKey: e.experiment_key, account });
    log('\n' + e.experiment_key + ': ' + (r.ok ? 'ACTIVATED' : 'FAILED'));
    (r.results || []).forEach((x) => log('   ' + x.object_type.padEnd(9) + x.provider_id
      + '  ' + (x.activated ? 'ACTIVE' : 'FAILED: ' + x.reason)));
    if (!r.ok) { console.error('Activation incomplete — leaving delivery as-is. ' + (r.reason || '')); return false; }
  }
  return true;
}

(async () => {
  const acct = await resolveAccount();
  log('Account: ' + acct.account + ' "' + acct.name + '"\n');

  if (has('plan')) return (await plan(acct.account)) ? 0 : 1;
  if (has('create')) { if (!(await plan(acct.account))) return 1; log('\n--- CREATE (paused) ---'); return (await create(acct.account)) ? 0 : 1; }
  if (has('verify')) { log('--- VERIFY ---'); const ok = await verify(acct.account); log('\nVERIFICATION: ' + (ok ? 'PASS' : 'FAIL')); return ok ? 0 : 1; }
  if (has('activate')) {
    log('--- VERIFY BEFORE ACTIVATION ---');
    const ok = await verify(acct.account);
    if (!ok) { console.error('\nREFUSING TO ACTIVATE: verification failed. Delivery remains paused.'); return 1; }
    log('\n--- ACTIVATE ---');
    return (await activate(acct.account)) ? 0 : 1;
  }
  console.error('Specify one of --plan --create --verify --activate');
  return 2;
})().then((c) => process.exit(c || 0)).catch((e) => { console.error(e); process.exit(1); });
