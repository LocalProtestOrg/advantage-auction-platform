#!/usr/bin/env node
/* prepare-tristate-market.js — prepare (NOT launch) the New York Tri-State In-Home Service Area.

   READ-ONLY at the provider. Writes only Advantage.Bid planning records:
     · market ny_tristate: provider-resolved geography, reach evidence, coverage report, version row
       (coverage stays PENDING OWNER GEOGRAPHY APPROVAL; launch_authorized stays false)
     · audience strategies IS-BROAD-TRI, IS-INTENT-TRI, PS-BROAD-TRI, PS-SMB-TRI (provider-validated)
     · campaign records for Individual Seller — Tri-State and Professional Seller — Tri-State
       (never reserved, never created at the provider)
     · the Individual Seller — Tri-State audience experiment plan (arms SHARE the campaign authorization)
     · a DRAFT creative package for the in-home proposition (not approved, not active)
   Nothing here reserves authority, creates a provider object, or can activate delivery.

   Every location key comes back from the provider's own geolocation search as a CITY in the named
   state; a missing or ambiguous result REFUSES rather than guessing. The footprint is circles around
   anchor communities, so the coverage report states the counties covered, partly covered, excluded,
   and the unavoidable spillover. Ad reach is not a promise that every person reached is eligible
   for in-home service.

     node scripts/prepare-tristate-market.js [--dry-run] */

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const ai = require('../src/services/paidGrowth/audienceIntelligenceService');
const meta = require('../src/services/paidGrowth/metaAdsProvider');
const delivery = require('../src/services/paidGrowth/metaDeliveryService');
const registry = require('../src/services/productionCreativeRegistry');
const governance = require('../src/services/paidGrowth/paidSpendGovernance');

const DRY = process.argv.includes('--dry-run');
const MARKET = 'ny_tristate';
const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'docs/marketing/tristate-coverage-report.md');

// Anchor communities and radii (miles). The provider's minimum city radius is 10 miles. Coordinates
// are APPROXIMATE public reference points used ONLY for the human coverage report — targeting uses
// the provider keys resolved below, never these numbers.
const ANCHORS = [
  { name: 'New York', region: 'New York', radius: 15, ll: [40.7128, -74.0060], serves: 'Manhattan, Brooklyn, Queens, the Bronx; Hudson County NJ' },
  { name: 'White Plains', region: 'New York', radius: 10, ll: [41.0340, -73.7629], serves: 'central / southern Westchester' },
  { name: 'Mineola', region: 'New York', radius: 10, ll: [40.7493, -73.6407], serves: 'Nassau County' },
  { name: 'New City', region: 'New York', radius: 10, ll: [41.1476, -73.9893], serves: 'Rockland County' },
  { name: 'Hackensack', region: 'New Jersey', radius: 10, ll: [40.8859, -74.0435], serves: 'Bergen County' },
  { name: 'Paterson', region: 'New Jersey', radius: 10, ll: [40.9168, -74.1718], serves: 'Passaic (south) and north Essex' },
  { name: 'Morristown', region: 'New Jersey', radius: 10, ll: [40.7968, -74.4815], serves: 'Morris County' },
  { name: 'Elizabeth', region: 'New Jersey', radius: 10, ll: [40.6640, -74.2107], serves: 'Union, south Essex, north Staten Island' },
  { name: 'Perth Amboy', region: 'New Jersey', radius: 10, ll: [40.5068, -74.2654], serves: 'Woodbridge area and south Staten Island' },
  { name: 'New Brunswick', region: 'New Jersey', radius: 10, ll: [40.4862, -74.4518], serves: 'Middlesex and east Somerset' },
  { name: 'Stamford', region: 'Connecticut', radius: 10, ll: [41.0534, -73.5387], serves: 'Greenwich, Stamford, Darien, New Canaan' },
  { name: 'Norwalk', region: 'Connecticut', radius: 10, ll: [41.1177, -73.4082], serves: 'Norwalk, Westport, Wilton, Weston' },
];

// Counties considered, with approximate centroids, for the coverage report only.
const COUNTIES = [
  ['New York (Manhattan)', 'NY', 40.7831, -73.9712], ['Kings (Brooklyn)', 'NY', 40.6501, -73.9496], ['Queens', 'NY', 40.7282, -73.7949],
  ['Bronx', 'NY', 40.8448, -73.8648], ['Richmond (Staten Island)', 'NY', 40.5795, -74.1502], ['Westchester', 'NY', 41.1220, -73.7949],
  ['Nassau', 'NY', 40.7289, -73.5894], ['Rockland', 'NY', 41.1489, -74.0260], ['Suffolk', 'NY', 40.9434, -72.6922],
  ['Putnam', 'NY', 41.4351, -73.7949], ['Orange', 'NY', 41.4020, -74.3118], ['Dutchess', 'NY', 41.7784, -73.7478],
  ['Hudson', 'NJ', 40.7453, -74.0535], ['Bergen', 'NJ', 40.9263, -74.0770], ['Essex', 'NJ', 40.7870, -74.2460],
  ['Passaic', 'NJ', 41.0337, -74.3000], ['Union', 'NJ', 40.6598, -74.3082], ['Morris', 'NJ', 40.8620, -74.5446],
  ['Middlesex', 'NJ', 40.4400, -74.4059], ['Somerset', 'NJ', 40.5638, -74.6168], ['Monmouth', 'NJ', 40.2589, -74.1240],
  ['Mercer', 'NJ', 40.2830, -74.7010], ['Hunterdon', 'NJ', 40.5654, -74.9120], ['Sussex', 'NJ', 41.1390, -74.6905],
  ['Warren', 'NJ', 40.8570, -75.0059], ['Ocean', 'NJ', 39.8670, -74.2500],
  ['Fairfield (southwest)', 'CT', 41.0900, -73.5000], ['Fairfield (east: Bridgeport / Danbury)', 'CT', 41.2800, -73.2500],
  ['New Haven', 'CT', 41.3490, -72.9000],
];

const miles = (a, b) => {
  const R = 3958.7613, rad = (d) => d * Math.PI / 180;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function coverage(anchors) {
  return COUNTIES.map(([name, st, lat, lng]) => {
    let best = null;
    for (const a of anchors) {
      const d = miles([lat, lng], a.ll);
      if (!best || d - a.radius < best.margin) best = { anchor: a.name, distance: d, margin: d - a.radius };
    }
    const status = best.margin <= -2 ? 'INCLUDED' : best.margin <= 8 ? 'PARTIAL' : 'EXCLUDED';
    return { county: name, state: st, status, nearest_anchor: best.anchor, approx_miles_from_anchor: Math.round(best.distance) };
  });
}

(async () => {
  const acct = await meta.resolveAdAccount();
  if (!acct.ok) { console.error('REFUSE: ' + acct.reason); return 2; }

  // 0. Spend must be certified before preparing new paid structure.
  const ov = await governance.overview();
  if (ov.reconciliation.state !== 'IN_SYNC') { console.error('REFUSE: spend reconciliation is ' + ov.reconciliation.state); return 2; }

  // 1. Resolve every anchor through the provider. Never guess a key.
  const resolved = [];
  for (const a of ANCHORS) {
    const r = await ai.discoverGeo(a.name + ', ' + a.region, { limit: 8 });
    if (!r.ok) { console.error('REFUSE: geolocation search failed for ' + a.name + ': ' + r.reason); return 2; }
    const hit = r.results.find((g) => g.type === 'city' && g.name === a.name && g.region === a.region && g.country_code === 'US');
    if (!hit) { console.error('REFUSE: no provider CITY "' + a.name + ', ' + a.region + '"'); return 2; }
    resolved.push({ ...a, key: String(hit.key) });
  }
  const geo = { cities: resolved.map((a) => ({ key: a.key, radius: a.radius, distance_unit: 'mile' })) };

  // 2. Provider reach per anchor and for the whole footprint (the provider de-duplicates overlap).
  const spec = ai.buildTargetingSpec({ geography: { geo_locations: geo }, audienceMode: 'broad' });
  const whole = await ai.estimateReach(spec, { account: acct.account });
  if (!whole.ok || !(Number(whole.upper) > 0)) { console.error('REFUSE: footprint did not validate: ' + (whole.reason || 'no reach')); return 2; }
  for (const a of resolved) {
    const e = await ai.estimateReach(ai.buildTargetingSpec({ geography: { geo_locations: { cities: [{ key: a.key, radius: a.radius, distance_unit: 'mile' }] } }, audienceMode: 'broad' }), { account: acct.account });
    a.reach = e.ok ? { lower: e.lower, upper: e.upper } : { error: e.reason };
  }
  const counties = coverage(resolved);
  console.log('Footprint reach (age ' + ai.MIN_AGE + '+): ' + whole.lower + ' – ' + whole.upper);
  resolved.forEach((a) => console.log('  ' + (a.name + ', ' + a.region).padEnd(26) + a.key.padEnd(9) + String(a.radius).padStart(3) + ' mi  '
    + (a.reach.lower ? a.reach.lower + '–' + a.reach.upper : 'ERR ' + a.reach.error)));
  counties.forEach((c) => console.log('  ' + c.status.padEnd(9) + (c.county + ' ' + c.state).padEnd(44) + '~' + c.approx_miles_from_anchor + ' mi from ' + c.nearest_anchor));

  const coverageDoc = {
    approval: 'PENDING OWNER GEOGRAPHY APPROVAL',
    reason: 'No documented Owner service boundary exists; the only prior definitions are an 87-mile events radius and a state-level (NY/NJ/CT) inquiry label, both far broader than an in-home service footprint.',
    method: 'provider city keys with mile radii around anchor communities; the provider de-duplicates overlap',
    anchors: resolved.map((a) => ({ name: a.name, region: a.region, key: a.key, radius_miles: a.radius, serves: a.serves, reach: a.reach })),
    footprint_reach: { lower: whole.lower, upper: whole.upper, min_age: ai.MIN_AGE },
    counties,
    spillover: [
      'Circles cross county and state lines: edge communities outside the listed service area can see ads (e.g. western Suffolk near the Nassau line, southern Orange near Rockland, northern Monmouth near Perth Amboy / New Brunswick, the Bridgeport edge of the Norwalk circle).',
      'The provider targets people living in or recently in a location, so commuters and visitors can be reached.',
      'Geographic targeting is not eligibility: an inquiry from a reached person may still be outside the in-home service footprint and must be qualified by the team.',
    ],
    not_targeted: 'The state regions of New York, New Jersey and Connecticut are NOT targeted; only the anchor circles are.',
    optional_additions_for_owner: ['Monmouth County (Freehold, key resolvable) — central NJ, excluded by default', 'eastern Fairfield County (Bridgeport / Danbury)', 'Suffolk County'],
  };

  const plan = {
    status: 'PREPARED — not launched; no provider objects; coverage PENDING OWNER GEOGRAPHY APPROVAL',
    shares_global_monthly_ceiling: true,
    additional_monthly_authority_cents: 0,
    campaigns: {
      individual_seller: '2026-10-individual-seller-tristate',
      professional_seller: '2026-10-professional-seller-tristate',
    },
  };

  if (DRY) { console.log('\nDRY RUN — nothing written.'); return 0; }

  // 3. Market + version history. Coverage approval is never set here.
  const cur = (await db.query('SELECT version, status, launch_authorized FROM marketing_paid_markets WHERE market_key=$1', [MARKET])).rows[0];
  if (!cur) { console.error('REFUSE: market ' + MARKET + ' missing (apply migration 164)'); return 1; }
  if (cur.status !== 'PREPARED' || cur.launch_authorized) { console.error('REFUSE: ' + MARKET + ' is no longer a PREPARED, un-authorized market'); return 1; }
  const geoSpec = { geo_locations: geo, label: 'New York Tri-State In-Home Service Area (' + resolved.length + ' anchors)' };
  await db.query(
    `UPDATE marketing_paid_markets SET geo_spec=$2::jsonb, geo_validation='VALID', geo_evidence=$3::jsonb, geo_validated_at=now(),
            coverage=$4::jsonb, plan = plan || $5::jsonb, updated_at=now()
      WHERE market_key=$1 AND status='PREPARED' AND launch_authorized=false`,
    [MARKET, JSON.stringify(geoSpec), JSON.stringify({ source: 'provider adgeolocation search + delivery_estimate', checked_at: new Date().toISOString(), account: acct.account }),
      JSON.stringify(coverageDoc), JSON.stringify(plan)]);
  await db.query(
    `INSERT INTO marketing_paid_market_versions (market_key, version, name, status, geo_spec, geo_validation, coverage, coverage_approval, reason)
     SELECT market_key, version, name, status, geo_spec, geo_validation, coverage, coverage_approval, 'provider-resolved Tri-State footprint (prepare-tristate-market.js)'
       FROM marketing_paid_markets WHERE market_key=$1
     ON CONFLICT (market_key, version) DO UPDATE SET geo_spec=EXCLUDED.geo_spec, coverage=EXCLUDED.coverage, recorded_at=now()`, [MARKET]);

  // 4. Audience strategies — provider-validated, market-specific keys, never Houston's rows.
  const houstonIntent = (await db.query(`SELECT inclusions FROM marketing_audience_strategies WHERE strategy_key='IS-INTENT-HOU'`)).rows[0];
  const houstonSmb = (await db.query(`SELECT inclusions FROM marketing_audience_strategies WHERE strategy_key='PS-SMB-HOU'`)).rows[0];
  const geography = { geo_locations: geo, market_key: MARKET, label: geoSpec.label };
  const strategies = [
    { strategyKey: 'IS-BROAD-TRI', funnel: 'individual_seller', audienceMode: 'advantage_plus', inclusions: [],
      hypothesis: 'Adults in the Tri-State service area, with provider optimisation, find the in-home auction service relevant.' },
    { strategyKey: 'IS-INTENT-TRI', funnel: 'individual_seller', audienceMode: 'detailed', inclusions: houstonIntent ? houstonIntent.inclusions : [],
      hypothesis: 'Tri-State adults interested in antiques, collectables or auctions are likelier to request in-home auction service.' },
    { strategyKey: 'PS-BROAD-TRI', funnel: 'professional_seller', audienceMode: 'advantage_plus', inclusions: [],
      hypothesis: 'Tri-State auction and estate-sale professionals, reached broadly, respond to the platform software proposition.' },
    { strategyKey: 'PS-SMB-TRI', funnel: 'professional_seller', audienceMode: 'detailed', inclusions: houstonSmb ? houstonSmb.inclusions : [],
      hypothesis: 'Tri-State small-business owners include the auction and estate-sale operators the software serves.' },
  ];
  for (const s of strategies) {
    const out = await ai.upsertStrategy({ ...s, geography, rationale: 'Tri-State market preparation (migration 164)', provenance: 'tristate_preparation' });
    console.log('strategy ' + s.strategyKey.padEnd(14) + out.validation_state + '  reach ' + (out.strategy.estimated_reach_lower || '?') + '–' + (out.strategy.estimated_reach_upper || '?'));
    if (out.validation_state !== 'VALID') { console.error('REFUSE: strategy ' + s.strategyKey + ' did not validate'); return 1; }
  }

  // 5. Draft creative: register the rendered candidate (UNAPPROVED — presence is not approval).
  // The registry is keyed by path and re-fingerprints whatever bytes it finds, so syncing from a
  // working tree whose governed files carry uncommitted edits would silently replace approved assets
  // with unapproved ones. Refuse unless every tracked production creative matches the commit.
  const dirty = require('child_process').execSync('git status --porcelain -- docs/marketing/production-creative', { cwd: ROOT }).toString()
    .split('\n').filter((l) => /^\s?M/.test(l));
  if (dirty.length) { console.error('REFUSE: tracked production creative has uncommitted changes:\n' + dirty.join('\n')); return 1; }
  await registry.sync({ grandfather: false });
  const draftImg = (await db.query(`SELECT id, sha256, owner_approved_for_production, production_eligible FROM marketing_production_creative
      WHERE filename='individual-seller-tristate-in-home-service-draft-v1.png'`)).rows[0];
  if (!draftImg) { console.error('REFUSE: draft creative not registered (run scripts/render-tristate-creative.js)'); return 1; }
  if (draftImg.owner_approved_for_production) { console.error('REFUSE: draft creative is unexpectedly approved'); return 1; }

  const pkg = {
    package_key: 'PKG-IS-TRI-INHOME-V1', funnel: 'individual_seller', audience_purpose: 'Tri-State in-home auction service',
    headline: 'The Smarter Way to Sell.',
    primary_text: 'Have a home full of items to sell? Advantage.Bid offers in-home auction service: our team helps set up your catalog and auction, manages the sale and coordinates pickup. Available in parts of the New York Tri-State area. Tell us about your sale and a member of our team will contact you.',
    description: 'In-home auction service in parts of the NY Tri-State area',
    cta_type: 'CONTACT_US',
    destination_url: 'https://bid.advantage.bid/assisted-service.html',
  };
  const fingerprint = delivery.packageFingerprint({ ...pkg, asset_sha256: draftImg.sha256 });
  await db.query(
    `INSERT INTO marketing_creative_packages (package_key, production_creative_id, funnel, audience_purpose, primary_text, headline, description,
       cta_type, destination_url, version, fingerprint, approval_state, policy_status, provenance, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,'DRAFT','OK','tristate_preparation — every claim traced to the Owner-confirmed service or /assisted-service.html',false)
     ON CONFLICT (package_key) DO UPDATE SET primary_text=EXCLUDED.primary_text, headline=EXCLUDED.headline, description=EXCLUDED.description,
       cta_type=EXCLUDED.cta_type, destination_url=EXCLUDED.destination_url, production_creative_id=EXCLUDED.production_creative_id,
       fingerprint=EXCLUDED.fingerprint, updated_at=now()
     WHERE marketing_creative_packages.approval_state = 'DRAFT'`,
    [pkg.package_key, draftImg.id, pkg.funnel, pkg.audience_purpose, pkg.primary_text, pkg.headline, pkg.description, pkg.cta_type, pkg.destination_url, fingerprint]);

  // Provider validation of the COPY (validate_only — nothing is created). The draft image cannot be
  // uploaded until approved, so an already-uploaded approved image stands in for the picture.
  const stand = (await db.query(`SELECT provider_image_hash FROM marketing_provider_images WHERE provider='meta' AND account_ref=$1 LIMIT 1`, [acct.account])).rows[0];
  const copy = { ...pkg, destination_url: delivery.buildDestination({ destinationUrl: pkg.destination_url, funnel: 'individual_seller',
    campaignKey: '2026-10-individual-seller-tristate', strategyKey: 'IS-BROAD-TRI', experimentKey: 'EXP-IS-TRI-2026-10', armLabel: 'A-broad', packageKey: pkg.package_key }) };
  const v = stand ? await delivery.validateChain({ account: acct.account, imageHash: stand.provider_image_hash, pkg: copy, funnel: 'individual_seller' }) : null;
  console.log('package ' + pkg.package_key + ' DRAFT  fingerprint ' + fingerprint.slice(0, 12) + '  provider copy validation: '
    + (v ? ('campaign ' + (v.campaign.ok ? 'ok' : v.campaign.reason) + ', creative ' + (v.adcreative.ok ? 'ok' : v.adcreative.reason)) : 'no uploaded image to validate against'));
  const attribution = [...new URL(copy.destination_url).searchParams.keys()];

  // 6. Campaign records — planning only. Budget is a PROPOSAL; nothing is reserved.
  const houston = (await db.query(`SELECT objective FROM marketing_paid_campaigns WHERE campaign_key='2026-10-individual-seller-houston'`)).rows[0];
  const housePs = (await db.query(`SELECT objective FROM marketing_paid_campaigns WHERE campaign_key='2026-10-professional-seller-houston'`)).rows[0];
  const upsertCampaign = async ({ key, funnel, objective, audience, destination, budget, creativeId, state, blocked }) => {
    await db.query(
      `INSERT INTO marketing_paid_campaigns (campaign_key, channel, objective, funnel, market, market_key, audience, destination_url,
         creative_id, budget_cents, state, blocked_reason, evidence)
       VALUES ($1,'meta_ads',$2,$3,'New York Tri-State In-Home Service Area',$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (campaign_key) DO UPDATE SET objective=EXCLUDED.objective, audience=EXCLUDED.audience, destination_url=EXCLUDED.destination_url,
         creative_id=EXCLUDED.creative_id, budget_cents=EXCLUDED.budget_cents, blocked_reason=EXCLUDED.blocked_reason, evidence=EXCLUDED.evidence, updated_at=now()
       WHERE marketing_paid_campaigns.provider_campaign_id IS NULL AND marketing_paid_campaigns.state IN ('PLANNED','CREATIVE_BLOCKED')`,
      [key, objective, funnel, MARKET, audience, destination, creativeId, budget, state, blocked,
        JSON.stringify({ prepared_by: 'prepare-tristate-market.js', budget_is_proposal_only: true, attribution_params: attribution })]);
  };
  await upsertCampaign({ key: '2026-10-individual-seller-tristate', funnel: 'individual_seller', objective: houston ? houston.objective : 'OUTCOME_LEADS',
    audience: 'Tri-State service-area households with items to sell — in-home auction service', destination: pkg.destination_url, budget: 13500,
    creativeId: draftImg.id, state: 'CREATIVE_BLOCKED', blocked: 'Tri-State in-home creative PKG-IS-TRI-INHOME-V1 is DRAFT — awaiting Owner approval' });
  const psPkg = (await db.query(`SELECT production_creative_id FROM marketing_creative_packages WHERE package_key='PKG-PS-HOU-V1'`)).rows[0];
  await upsertCampaign({ key: '2026-10-professional-seller-tristate', funnel: 'professional_seller', objective: housePs ? housePs.objective : 'OUTCOME_LEADS',
    audience: 'Tri-State auction houses, estate sale companies and liquidators — platform software (no in-home service claim)',
    destination: 'https://bid.advantage.bid/become-professional-seller.html', budget: 0, creativeId: psPkg ? psPkg.production_creative_id : null,
    state: 'PLANNED', blocked: 'prepared only — not authorized for launch' });

  // 7. The Individual Seller — Tri-State experiment: two arms SHARING the $135 proposal.
  const exp = await ai.planExperiment({ experimentKey: 'EXP-IS-TRI-2026-10', campaignKey: '2026-10-individual-seller-tristate',
    hypothesis: 'Replicates the Houston audience contrast (broad vs intent) under a DIFFERENT proposition (in-home service) and outcome (service inquiry), with the creative held constant, so market and audience effects can be read separately.',
    arms: [{ label: 'A-broad', strategyKey: 'IS-BROAD-TRI', allocatedCents: 6750 }, { label: 'B-intent', strategyKey: 'IS-INTENT-TRI', allocatedCents: 6750 }] });
  console.log('experiment EXP-IS-TRI-2026-10: ' + (exp.ok ? 'planned' : 'REFUSED ' + exp.reason));
  await db.query(`UPDATE marketing_audience_experiments SET state='PLANNED', updated_at=now() WHERE experiment_key='EXP-IS-TRI-2026-10' AND state NOT IN ('RUNNING','COMPLETE')`).catch(() => {});

  // 8. Human-readable coverage report.
  const lines = [
    '# New York Tri-State In-Home Service Area — coverage report', '',
    '**Status: PENDING OWNER GEOGRAPHY APPROVAL.** ' + coverageDoc.reason, '',
    'Generated ' + new Date().toISOString() + ' by `scripts/prepare-tristate-market.js`. Location keys come from the provider\'s own',
    'geolocation search; reach is the provider\'s delivery estimate for adults aged ' + ai.MIN_AGE + '+. Distances are approximate.', '',
    '**Whole footprint reach:** ' + whole.lower.toLocaleString() + ' – ' + whole.upper.toLocaleString() + ' people (overlap de-duplicated by the provider).', '',
    '## Anchors (targeted)', '', '| Anchor | Provider key | Radius | Intended coverage | Reach |', '|---|---|---|---|---|',
    ...resolved.map((a) => `| ${a.name}, ${a.region} | ${a.key} | ${a.radius} mi | ${a.serves} | ${a.reach.lower ? a.reach.lower.toLocaleString() + '–' + a.reach.upper.toLocaleString() : 'n/a'} |`),
    '', '## Counties', '', '| County | State | Coverage | Nearest anchor (≈ mi) |', '|---|---|---|---|',
    ...counties.map((c) => `| ${c.county} | ${c.state} | ${c.status} | ${c.nearest_anchor} (${c.approx_miles_from_anchor}) |`),
    '', '## Spillover and limits', '', ...coverageDoc.spillover.map((s) => '- ' + s), '- ' + coverageDoc.not_targeted, '',
    '## Optional additions for the Owner to decide', '', ...coverageDoc.optional_additions_for_owner.map((s) => '- ' + s), '',
  ];
  fs.writeFileSync(REPORT, lines.join('\n'));
  console.log('\ncoverage report: ' + path.relative(ROOT, REPORT));
  console.log('RESULT: PREPARED — nothing reserved, nothing created at the provider, nothing launch-authorized.');
  return 0;
})().then((code) => db.pool.end().then(() => process.exit(code || 0)))
  .catch((e) => { console.error('ERR ' + meta.redact(e.stack || e.message)); db.pool.end().then(() => process.exit(1)); });
