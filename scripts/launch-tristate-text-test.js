#!/usr/bin/env node
/* launch-tristate-text-test.js — the Owner's controlled $25 TOTAL Tri-State text-creative test.

   Owner decision (2026-09-23): the $135 Tri-State proposal is NOT authorized. Instead ONE campaign,
   ONE audience (IS-BROAD-TRI), ONE creative (PKG-IS-TRI-INHOME-V1, approved for this test only),
   destination /assisted-service.html, $25.00 TOTAL from the shared $1,000 monthly ceiling.

   Money controls, outermost to innermost:
     1. the ledger reserves exactly $25 before anything reaches the provider;
     2. the ad set carries a $25 LIFETIME budget — a hard provider-side total. (Meta refuses campaign
        spend caps below $100, so the campaign cannot carry the cap itself);
     3. governance auto-stops the campaign when provider spend reaches $25 and refuses any restart;
     4. the package approval is SCOPED to this campaign and $25, so it cannot fund anything larger.

   Phases, each refusing unless the one before succeeded:
     --geography   resolve the Owner-approved additions through the provider, validate reach, record
                   version 2 of the market with Owner approval, re-validate the Tri-State strategies
     --prepare     scoped creative approval; campaign + single-arm experiment records; mark the $135
                   proposal NOT AUTHORIZED
     --create      forced fresh spend sync → reserve $25 → build campaign/ad set/creative/ad PAUSED
     --verify      read every object back from the provider and compare with the authorization
     --activate    verify again, then activate; nothing activates if any check fails */

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const meta = require('../src/services/paidGrowth/metaAdsProvider');
const delivery = require('../src/services/paidGrowth/metaDeliveryService');
const ai = require('../src/services/paidGrowth/audienceIntelligenceService');
const governance = require('../src/services/paidGrowth/paidSpendGovernance');
const ledger = require('../src/services/paidBudgetLedger');
const footprint = require('../src/services/paidGrowth/tristateFootprint');

const has = (f) => process.argv.includes('--' + f);
const log = (...a) => console.log(...a);

const T = Object.freeze({
  market_key: 'ny_tristate',
  campaign_key: '2026-09-individual-seller-tristate-text-test',
  experiment_key: 'EXP-IS-TRI-TEXT-2026-09',
  arm: 'A-broad',
  strategy_key: 'IS-BROAD-TRI',
  package_key: 'PKG-IS-TRI-INHOME-V1',
  destination: 'https://bid.advantage.bid/assisted-service.html',
  authorization_cents: 2500,
  schedule_days: 5,                 // $25 over 5 days ≈ $5/day: slow, conservative pacing
  custom_event_type: 'LEAD',        // the destination's conversion is a service inquiry (Lead)
  min_age: 25,
  declined_campaign_key: '2026-10-individual-seller-tristate',
  declined_experiment_key: 'EXP-IS-TRI-2026-10',
  owner_decision: 'Owner decision 2026-09-23: controlled $25 TOTAL Tri-State text-only creative test; $135 proposal not authorized',
});
const REPORT = path.join(__dirname, '..', 'docs/marketing/tristate-coverage-report.md');

async function account() {
  const a = await meta.resolveAdAccount();
  if (!a.ok) throw new Error('REFUSE: ' + a.reason);
  return a.account;
}

// ── geography ─────────────────────────────────────────────────────────────────────────────────

async function geography(acct) {
  const m = (await db.query('SELECT * FROM marketing_paid_markets WHERE market_key=$1', [T.market_key])).rows[0];
  if (!m) { console.error('REFUSE: market missing'); return false; }
  const resolved = [];
  for (const a of footprint.V2) {
    const r = await ai.discoverGeo(a.name + ', ' + a.region, { limit: 8 });
    if (!r.ok) { console.error('REFUSE: geolocation search failed for ' + a.name); return false; }
    const hit = r.results.find((g) => g.type === 'city' && g.name === a.name && g.region === a.region && g.country_code === 'US');
    if (!hit) { console.error('REFUSE: no provider CITY "' + a.name + ', ' + a.region + '"'); return false; }
    resolved.push({ ...a, key: String(hit.key) });
  }
  // Version-1 anchors must resolve to exactly the keys already validated.
  const v1Keys = ((m.geo_spec || {}).geo_locations || {}).cities || [];
  for (const c of v1Keys) {
    if (!resolved.some((r) => r.key === String(c.key) && r.radius === Number(c.radius))) { console.error('REFUSE: version-1 anchor ' + c.key + ' no longer resolves identically'); return false; }
  }
  const geo = { cities: resolved.map((a) => ({ key: a.key, radius: a.radius, distance_unit: 'mile' })) };
  const whole = await ai.estimateReach(ai.buildTargetingSpec({ geography: { geo_locations: geo }, audienceMode: 'broad' }), { account: acct });
  if (!whole.ok || !(Number(whole.upper) > 0)) { console.error('REFUSE: footprint did not validate'); return false; }
  const added = [];
  for (const a of resolved.filter((r) => footprint.V2_ADDITIONS.some((x) => x.name === r.name && x.region === r.region))) {
    const e = await ai.estimateReach(ai.buildTargetingSpec({ geography: { geo_locations: { cities: [{ key: a.key, radius: a.radius, distance_unit: 'mile' }] } }, audienceMode: 'broad' }), { account: acct });
    added.push({ name: a.name, region: a.region, key: a.key, radius_miles: a.radius, serves: a.serves, reach: e.ok ? { lower: e.lower, upper: e.upper } : { error: e.reason } });
  }
  const counties = footprint.coverage(resolved);
  const spill = footprint.spilloverIntoExcluded(resolved);
  if (spill.some((s) => s.severity === 'CENTROID_INSIDE')) { console.error('REFUSE: an excluded county would be targeted: ' + JSON.stringify(spill)); return false; }

  log('Version 2 footprint: ' + resolved.length + ' anchors, reach ' + whole.lower + '–' + whole.upper + ' (age ' + ai.MIN_AGE + '+)');
  added.forEach((a) => log('  ADDED ' + (a.name + ', ' + a.region).padEnd(24) + a.key.padEnd(9) + a.radius_miles + ' mi  reach ' + (a.reach.lower || '?') + '–' + (a.reach.upper || '?')));
  counties.forEach((c) => log('  ' + c.owner_decision.padEnd(8) + c.status.padEnd(9) + c.county + ' ' + c.state));
  if (spill.length) log('  edge spillover near excluded areas: ' + JSON.stringify(spill));

  const coverageDoc = { ...(m.coverage || {}), version: 2, approval: 'OWNER_APPROVED (with adjustments)', approval_evidence: T.owner_decision,
    added_anchors: added, footprint_reach: { lower: whole.lower, upper: whole.upper, min_age: ai.MIN_AGE }, counties,
    not_added_by_owner: ['Suffolk', 'Putnam', 'Orange', 'Dutchess', 'Mercer', 'Hunterdon', 'Sussex', 'Warren', 'Ocean', 'New Haven'],
    spillover: [
      'The Freehold circle reaches a strip of northern Ocean County along the Howell / Lakewood / Jackson line; Ocean itself is not targeted.',
      'The Fairfield (CT) circle reaches the Milford edge of New Haven County; New Haven County itself is not targeted.',
      'Existing version-1 edges still apply (western Suffolk near Nassau, southern Orange near Rockland).',
      'The provider reaches people living in or recently in a location; reach is not service eligibility, and every inquiry is qualified by the team.',
    ] };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const nextVersion = Number(m.version || 1) + 1;
    await client.query(
      `UPDATE marketing_paid_markets SET geo_spec=$2::jsonb, geo_validation='VALID', geo_validated_at=now(), coverage=$3::jsonb,
              coverage_approval='OWNER_APPROVED', coverage_approved_at=now(), launch_authorized=true, launch_authorized_at=now(),
              status='ACTIVE', version=$4, notes=COALESCE(notes,'') || ' ' || $5, updated_at=now()
        WHERE market_key=$1`,
      [T.market_key, JSON.stringify({ geo_locations: geo, label: 'New York Tri-State In-Home Service Area (' + resolved.length + ' anchors, v' + nextVersion + ')' }),
        JSON.stringify(coverageDoc), nextVersion, T.owner_decision]);
    await client.query(
      `INSERT INTO marketing_paid_market_versions (market_key, version, name, status, geo_spec, geo_validation, coverage, coverage_approval, reason)
       SELECT market_key, version, name, status, geo_spec, geo_validation, coverage, coverage_approval, $2 FROM marketing_paid_markets WHERE market_key=$1
       ON CONFLICT (market_key, version) DO NOTHING`, [T.market_key, 'Owner-approved v2: + Monmouth, + eastern Fairfield. ' + T.owner_decision]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); console.error('REFUSE: ' + e.message); return false; } finally { client.release(); }

  // Every Tri-State strategy now targets version 2, re-validated by the provider.
  for (const key of ['IS-BROAD-TRI', 'IS-INTENT-TRI', 'PS-BROAD-TRI', 'PS-SMB-TRI']) {
    const s = (await db.query('SELECT * FROM marketing_audience_strategies WHERE strategy_key=$1', [key])).rows[0];
    if (!s) continue;
    const out = await ai.upsertStrategy({ strategyKey: s.strategy_key, funnel: s.funnel, hypothesis: s.hypothesis, rationale: s.rationale,
      geography: { geo_locations: geo, market_key: T.market_key, version: 2 }, inclusions: s.inclusions, exclusions: s.exclusions,
      optimizationGoal: s.optimization_goal, audienceMode: s.audience_mode, provenance: 'tristate_v2_owner_approved' });
    log('  strategy ' + key.padEnd(14) + out.validation_state + '  reach ' + out.strategy.estimated_reach_lower + '–' + out.strategy.estimated_reach_upper);
    if (out.validation_state !== 'VALID') { console.error('REFUSE: ' + key + ' did not re-validate'); return false; }
  }

  // Human-readable report (version 2).
  const lines = ['# New York Tri-State In-Home Service Area — coverage report (version 2)', '',
    '**Status: OWNER APPROVED with adjustments (2026-09-23).** Monmouth County and practical eastern Fairfield County added;',
    'Suffolk, Putnam, Orange, Dutchess, Mercer, Hunterdon, Sussex, Warren, Ocean and New Haven deliberately NOT added.', '',
    'Location keys come from the provider\'s own geolocation search; reach is the provider\'s delivery estimate for adults aged ' + ai.MIN_AGE + '+.',
    'County coverage uses approximate centroids and is indicative only. State regions are never targeted.', '',
    '**Whole footprint reach:** ' + Number(whole.lower).toLocaleString() + ' – ' + Number(whole.upper).toLocaleString() + ' people.', '',
    '## Anchors (targeted)', '', '| Anchor | Provider key | Radius | Intended coverage | Version |', '|---|---|---|---|---|',
    ...resolved.map((a) => `| ${a.name}, ${a.region} | ${a.key} | ${a.radius} mi | ${a.serves} | ${footprint.V2_ADDITIONS.some((x) => x.name === a.name) ? 'added v2' : 'v1'} |`),
    '', '## Added in version 2', '', '| Anchor | Key | Radius | Reach |', '|---|---|---|---|',
    ...added.map((a) => `| ${a.name}, ${a.region} | ${a.key} | ${a.radius_miles} mi | ${a.reach.lower ? Number(a.reach.lower).toLocaleString() + '–' + Number(a.reach.upper).toLocaleString() : 'n/a'} |`),
    '', '## Counties', '', '| County | State | Owner decision | Coverage (approx.) | Nearest anchor (≈ mi) |', '|---|---|---|---|---|',
    ...counties.map((c) => `| ${c.county} | ${c.state} | ${c.owner_decision} | ${c.status} | ${c.nearest_anchor} (${c.approx_miles_from_anchor}) |`),
    '', '## Spillover and limits', '', ...coverageDoc.spillover.map((s) => '- ' + s), ''];
  fs.writeFileSync(REPORT, lines.join('\n'));
  log('coverage report updated: docs/marketing/tristate-coverage-report.md');
  return true;
}

// ── prepare ───────────────────────────────────────────────────────────────────────────────────

async function prepare() {
  const mk = await governance.assertMarketLaunchable({ marketKey: T.market_key });
  if (!mk.ok) { console.error('REFUSE: ' + mk.reason + ' (run --geography first)'); return false; }
  const pkg = (await db.query(`SELECT p.*, c.id AS image_id FROM marketing_creative_packages p
      JOIN marketing_production_creative c ON c.id=p.production_creative_id WHERE p.package_key=$1`, [T.package_key])).rows[0];
  if (!pkg) { console.error('REFUSE: package missing'); return false; }
  if (pkg.destination_url !== T.destination) { console.error('REFUSE: package destination changed'); return false; }

  const scope = { campaign_keys: [T.campaign_key], max_authorization_cents: T.authorization_cents,
    purpose: 'controlled $25 TOTAL text-only Tri-State creative test — not approval for any larger campaign' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // The image: approved for production use, so the governed upload can happen. Recorded as Owner decision.
    await client.query(
      `UPDATE marketing_production_creative SET owner_approved_for_production=true, approval_source='owner_decision_scoped_test_2026-09-23',
              approval_recorded_at=now(), production_eligible=true, ineligible_reason=NULL, provenance='OWNER_APPROVED_PRODUCTION', updated_at=now()
        WHERE id=$1`, [pkg.image_id]);
    // The package: approved, but ONLY within the scope. The copy and image are not modified.
    await client.query(
      `UPDATE marketing_creative_packages SET approval_state='OWNER_APPROVED', active=true, approval_scope=$2::jsonb,
              approval_recorded_at=now(), approval_evidence=$3, updated_at=now()
        WHERE package_key=$1 AND approval_state IN ('DRAFT','OWNER_APPROVED')`, [T.package_key, JSON.stringify(scope), T.owner_decision]);

    // The single test campaign. Authorization is $25 total; it auto-stops at $25 and never restarts itself.
    const houston = (await client.query(`SELECT objective FROM marketing_paid_campaigns WHERE campaign_key='2026-10-individual-seller-houston'`)).rows[0];
    await client.query(
      `INSERT INTO marketing_paid_campaigns (campaign_key, channel, objective, funnel, market, market_key, audience, destination_url,
         creative_id, budget_cents, state, evidence)
       VALUES ($1,'meta_ads',$2,'individual_seller','New York Tri-State In-Home Service Area',$3,$4,$5,$6,$7,'PLANNED',$8::jsonb)
       ON CONFLICT (campaign_key) DO NOTHING`,
      [T.campaign_key, houston ? houston.objective : 'OUTCOME_LEADS', T.market_key, 'Tri-State service-area households — in-home auction service (text-only creative test)',
        T.destination, pkg.image_id, T.authorization_cents,
        JSON.stringify({ auto_stop_at_authorization: true, authorization: 'TOTAL $25.00 — ' + T.owner_decision,
          no_automatic_scaling: true, no_second_audience: true, no_creative_replacement: true })]);

    // The declined $135 proposal stays on record, visibly NOT authorized.
    await client.query(
      `UPDATE marketing_paid_campaigns SET blocked_reason='NOT AUTHORIZED — Owner declined the $135 proposal (2026-09-23)',
              evidence = evidence || '{"owner_declined": true}'::jsonb, updated_at=now()
        WHERE campaign_key=$1 AND provider_campaign_id IS NULL`, [T.declined_campaign_key]);
    await client.query(`UPDATE marketing_audience_experiments SET state='ABANDONED', updated_at=now() WHERE experiment_key=$1 AND state='PLANNED'`, [T.declined_experiment_key]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); console.error('REFUSE: ' + e.message); return false; } finally { client.release(); }

  const exp = await ai.planExperiment({ experimentKey: T.experiment_key, campaignKey: T.campaign_key,
    hypothesis: 'Does the simple text-only in-home creative earn meaningful engagement in the Tri-State area? One audience, $25 total — an engagement read, not an audience comparison.',
    arms: [{ label: T.arm, strategyKey: T.strategy_key, allocatedCents: T.authorization_cents }] });
  if (!exp.ok) { console.error('REFUSE: experiment: ' + exp.reason); return false; }
  log('prepared: package scoped to ' + T.campaign_key + ' ≤ $25; campaign PLANNED $25; experiment ' + T.experiment_key + ' (1 arm); $135 proposal marked NOT AUTHORIZED');
  return true;
}

// ── create (PAUSED) ───────────────────────────────────────────────────────────────────────────

async function create(acct) {
  const fresh = await governance.ensureFreshSpend({ maxAgeMinutes: 0, trigger: 'tristate_text_test_create' });
  if (!fresh.ok) { console.error('REFUSE: ' + fresh.reason); return false; }
  const ov = await governance.overview();
  log('fresh spend: ' + ov.reconciliation.state + '  Meta month $' + (ov.position.actual_spend_cents / 100).toFixed(2)
    + '  uncommitted $' + (ov.position.uncommitted_authority_cents / 100).toFixed(2));
  if (ov.reconciliation.state !== 'IN_SYNC') { console.error('REFUSE: reconciliation is ' + ov.reconciliation.state); return false; }
  if (ov.position.uncommitted_authority_cents < T.authorization_cents) { console.error('REFUSE: $25 does not fit'); return false; }

  const res = await ledger.reserve({ campaignKey: T.campaign_key, amountCents: T.authorization_cents,
    idempotencyKey: 'campaign:' + T.campaign_key, note: T.owner_decision });
  if (!res.ok) { console.error('BUDGET REFUSED: ' + res.reason); return false; }
  log('reserved $25.00' + (res.replayed ? ' (replayed)' : ''));

  const start = new Date(Date.now() + 5 * 60000);
  const end = new Date(start.getTime() + T.schedule_days * 86400000);
  const r = await delivery.buildExperimentHierarchy({ experimentKey: T.experiment_key, account: acct,
    dailyCeilingCentsForExperiment: Math.ceil(T.authorization_cents / T.schedule_days), packageKeyByArm: { [T.arm]: T.package_key },
    lifetimeSchedule: { startTime: start.toISOString(), endTime: end.toISOString() }, customEventType: T.custom_event_type });
  if (!r.ok) {
    console.error('BUILD FAILED: ' + r.reason);
    const ledgerRow = (await db.query(`SELECT 1 FROM marketing_provider_objects WHERE campaign_key=$1 AND certification_artifact=false`, [T.campaign_key])).rows[0];
    if (!ledgerRow) await ledger.release({ campaignKey: T.campaign_key, amountCents: T.authorization_cents, idempotencyKey: 'campaign:' + T.campaign_key + ':release', note: 'build failed' });
    return false;
  }
  log('built PAUSED: campaign ' + r.built.campaign_id);
  r.built.arms.forEach((a) => log('  ' + a.arm + '  adset=' + a.adset_id + '  creative=' + a.creative_id + '  ad=' + a.ad_id));
  return true;
}

// ── verify ────────────────────────────────────────────────────────────────────────────────────

async function verify(acct, { expectActive = false } = {}) {
  let ok = true;
  const fail = (m) => { console.error('   MISMATCH: ' + m); ok = false; };
  const objs = (await db.query(`SELECT object_type, provider_id FROM marketing_provider_objects
      WHERE account_ref=$1 AND campaign_key=$2 AND certification_artifact=false`, [acct, T.campaign_key])).rows;
  const by = (t) => objs.filter((o) => o.object_type === t);
  if (by('campaign').length !== 1 || by('adset').length !== 1 || by('adcreative').length !== 1 || by('ad').length !== 1) {
    fail('expected exactly 1 campaign, 1 ad set, 1 creative, 1 ad; found ' + JSON.stringify(objs.map((o) => o.object_type)));
    return false;
  }
  const want = expectActive ? 'ACTIVE' : 'PAUSED';
  const market = (await db.query('SELECT geo_spec, status, launch_authorized, coverage_approval FROM marketing_paid_markets WHERE market_key=$1', [T.market_key])).rows[0];
  if (market.status !== 'ACTIVE' || !market.launch_authorized || market.coverage_approval !== 'OWNER_APPROVED') fail('market is not Owner-approved and launch-authorized');
  const wantGeo = market.geo_spec.geo_locations.cities.map((c) => c.key + ':' + c.radius).sort().join(',');

  const c = await meta.getObject('campaign', by('campaign')[0].provider_id);
  if (!c.ok) { fail('campaign unreadable'); return false; }
  log('campaign ' + c.object.id + '  status=' + c.object.status + '  objective=' + c.object.objective + '  spend_cap=' + (c.object.spend_cap || 'none (below Meta $100 minimum)'));
  if (c.object.status !== want) fail('campaign is ' + c.object.status);
  if (c.object.spend_cap && Number(c.object.spend_cap) > 10000) fail('campaign spend cap above the minimum backstop');

  const s = await meta.getObject('adset', by('adset')[0].provider_id);
  if (!s.ok) { fail('ad set unreadable'); return false; }
  const t = s.object.targeting || {};
  const gotGeo = ((t.geo_locations || {}).cities || []).map((x) => x.key + ':' + x.radius).sort().join(',');
  log('adset ' + s.object.id + '  status=' + s.object.status + '  lifetime_budget=$' + (Number(s.object.lifetime_budget || 0) / 100).toFixed(2)
    + '  daily_budget=' + (s.object.daily_budget || 'none') + '  ' + s.object.start_time + ' → ' + s.object.end_time);
  log('      goal=' + s.object.optimization_goal + '  event=' + ((s.object.promoted_object || {}).custom_event_type) + '  age_min=' + t.age_min
    + '  locations=' + ((t.geo_locations || {}).cities || []).length + '  regions=' + JSON.stringify((t.geo_locations || {}).regions || []));
  if (s.object.status !== want) fail('ad set is ' + s.object.status);
  if (Number(s.object.lifetime_budget) !== T.authorization_cents) fail('ad set lifetime budget is not exactly $25.00');
  if (Number(s.object.daily_budget || 0) > 0) fail('ad set carries a daily budget');
  if (!s.object.end_time) fail('ad set has no end time');
  if (gotGeo !== wantGeo) fail('ad set geography differs from the Owner-approved footprint');
  if ((t.geo_locations || {}).regions || (t.geo_locations || {}).countries) fail('ad set targets a region or country');
  if (Number(t.age_min) < T.min_age) fail('age floor below ' + T.min_age);
  if (String(s.object.campaign_id) !== String(c.object.id)) fail('ad set not under the test campaign');
  if (((s.object.promoted_object || {}).custom_event_type) !== T.custom_event_type) fail('optimization event is not LEAD');

  const k = await meta.getObject('adcreative', by('adcreative')[0].provider_id);
  const ld = ((k.object || {}).object_story_spec || {}).link_data || {};
  const url = new URL(ld.link || 'https://invalid.example');
  log('creative ' + (k.object || {}).id + '  link=' + String(ld.link).slice(0, 120));
  if (url.origin + url.pathname !== T.destination) fail('creative destination is not /assisted-service.html');
  for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'adv_funnel', 'adv_experiment', 'adv_arm', 'adv_provider']) {
    if (!url.searchParams.get(p)) fail('missing attribution parameter ' + p);
  }
  if (url.searchParams.get('utm_campaign') !== T.campaign_key || url.searchParams.get('utm_term') !== T.strategy_key
    || url.searchParams.get('utm_content') !== T.package_key || url.searchParams.get('adv_arm') !== T.arm) fail('attribution values differ from the test');
  if (!ld.image_hash) fail('creative has no image');

  const a = await meta.getObject('ad', by('ad')[0].provider_id);
  log('ad ' + a.object.id + '  status=' + a.object.status + '  adset=' + a.object.adset_id + '  creative=' + (a.object.creative || {}).id);
  if (a.object.status !== want) fail('ad is ' + a.object.status);
  if (String(a.object.adset_id) !== String(s.object.id) || String((a.object.creative || {}).id) !== String(k.object.id)) fail('ad wiring differs');

  const pkg = (await db.query('SELECT approval_state, approval_scope, active FROM marketing_creative_packages WHERE package_key=$1', [T.package_key])).rows[0];
  if (!pkg.approval_scope || pkg.approval_scope.max_authorization_cents !== T.authorization_cents
    || JSON.stringify(pkg.approval_scope.campaign_keys) !== JSON.stringify([T.campaign_key])) fail('package approval is not scoped to this $25 test');
  const led = (await db.query(`SELECT COALESCE(sum(CASE kind WHEN 'commit' THEN amount_cents WHEN 'release' THEN -amount_cents ELSE 0 END),0)::int n
      FROM marketing_paid_budget_ledger WHERE campaign_key=$1`, [T.campaign_key])).rows[0].n;
  if (led !== T.authorization_cents) fail('ledger authorization for the test is $' + (led / 100).toFixed(2));

  // Nothing unexpected at the provider: Houston's two campaigns plus this one.
  const all = await meta.listCampaigns({ account: acct });
  const names = (all.campaigns || []).map((x) => x.name);
  log('provider campaigns: ' + names.length + '  ' + JSON.stringify(names));
  const allowed = ['ADV — 2026-10-individual-seller-houston', 'ADV — 2026-10-professional-seller-houston', 'ADV — ' + T.campaign_key];
  if (names.length !== 3 || names.some((n) => !allowed.includes(n))) fail('unexpected provider campaigns');
  const ps = (await db.query(`SELECT state, budget_cents, provider_campaign_id FROM marketing_paid_campaigns WHERE campaign_key='2026-10-professional-seller-tristate'`)).rows[0];
  if (!ps || ps.state !== 'PLANNED' || Number(ps.budget_cents) !== 0 || ps.provider_campaign_id) fail('Professional Seller Tri-State is not PLANNED at $0');
  return ok;
}

(async () => {
  const acct = await account();
  if (has('geography')) return (await geography(acct)) ? 0 : 1;
  if (has('prepare')) return (await prepare()) ? 0 : 1;
  if (has('create')) return (await create(acct)) ? 0 : 1;
  if (has('verify')) { const ok = await verify(acct); log('\nVERIFICATION (PAUSED): ' + (ok ? 'PASS' : 'FAIL')); return ok ? 0 : 1; }
  if (has('verify-active')) { const ok = await verify(acct, { expectActive: true }); log('\nVERIFICATION (ACTIVE): ' + (ok ? 'PASS' : 'FAIL')); return ok ? 0 : 1; }
  if (has('activate')) {
    const ok = await verify(acct);
    if (!ok) { console.error('\nREFUSING TO ACTIVATE: verification failed. Delivery remains PAUSED.'); return 1; }
    const r = await delivery.activateExperiment({ experimentKey: T.experiment_key, account: acct });
    (r.results || []).forEach((x) => log('  ' + x.object_type.padEnd(9) + x.provider_id + '  ' + (x.activated ? 'ACTIVE' : 'FAILED: ' + x.reason)));
    if (!r.ok) { console.error('ACTIVATION INCOMPLETE: ' + (r.reason || '')); return 1; }
    log('ACTIVATED');
    return 0;
  }
  console.error('Specify one of --geography --prepare --create --verify --activate --verify-active');
  return 2;
})().then((c) => db.pool.end().then(() => process.exit(c || 0)))
  .catch((e) => { console.error(meta.redact(e.stack || e.message)); db.pool.end().then(() => process.exit(1)); });
