#!/usr/bin/env node
/* prepare-nyc-market.js — prepare (NOT launch) New York City as the next seller acquisition market.

   What it does, all READ-ONLY at the provider:
     1. Resolve "New York" through the provider's own geolocation search. The key is never typed in
        by hand: it must come back from the provider as a CITY in the state of New York, US — a
        REGION result would be the entire state, which is exactly what must not be targeted.
     2. Validate the resulting radius targeting with a provider delivery estimate (reach > 0), and
        record the neighbouring radii as evidence for the choice.
     3. Record the validated geography and the prepared experiment plan on marketing_paid_markets.

   What it never does: create a campaign, ad set, creative or ad; authorize launch; allocate money.
   The market stays PREPARED with launch_authorized = false, and it shares the ONE global monthly
   ceiling with Houston — there is no NYC budget to create.

     node scripts/prepare-nyc-market.js            # resolve + validate + record
     node scripts/prepare-nyc-market.js --dry-run  # resolve + validate, write nothing */

const db = require('../src/db');
const ai = require('../src/services/paidGrowth/audienceIntelligenceService');
const meta = require('../src/services/paidGrowth/metaAdsProvider');

const DRY = process.argv.includes('--dry-run');
// 20 miles from the provider's New York City centre covers the five boroughs with a tight margin
// (Houston, a sprawling metro, uses 25). Provider city radius must be between 10 and 50 miles.
const RADIUS_MILES = 20;
const EVIDENCE_RADII = [15, 20, 25];

(async () => {
  const acct = await meta.resolveAdAccount();
  if (!acct.ok) { console.error('REFUSE: ' + acct.reason); return 2; }

  const found = await ai.discoverGeo('New York');
  if (!found.ok) { console.error('REFUSE: geolocation search failed: ' + found.reason); return 2; }
  const city = found.results.find((g) => g.type === 'city' && g.name === 'New York' && g.region === 'New York' && g.country_code === 'US');
  if (!city) { console.error('REFUSE: the provider returned no New York CITY result', JSON.stringify(found.results)); return 2; }
  const stateResult = found.results.find((g) => g.type === 'region' && g.name === 'New York');
  if (stateResult && stateResult.key === city.key) { console.error('REFUSE: city and state keys coincide — would target the whole state'); return 2; }
  console.log('provider city: ' + city.name + ', ' + city.region + ' (' + city.type + ') key ' + city.key
    + (stateResult ? '   [state key ' + stateResult.key + ' deliberately NOT used]' : ''));

  const estimates = {};
  for (const radius of EVIDENCE_RADII) {
    const spec = ai.buildTargetingSpec({ geography: { key: city.key, radius, distance_unit: 'mile' }, audienceMode: 'broad' });
    const est = await ai.estimateReach(spec, { account: acct.account });
    estimates[radius] = est.ok ? { lower: est.lower, upper: est.upper, ready: est.ready } : { error: est.reason };
    console.log('  radius ' + radius + ' mi: ' + (est.ok ? (est.lower + ' – ' + est.upper + ' people (age ' + ai.MIN_AGE + '+)') : 'ERROR ' + est.reason));
  }
  const chosen = estimates[RADIUS_MILES];
  if (!chosen || chosen.error || !(Number(chosen.upper) > 0)) { console.error('REFUSE: the chosen radius did not validate'); return 2; }

  const geoSpec = { geo_locations: { cities: [{ key: String(city.key), radius: RADIUS_MILES, distance_unit: 'mile' }] },
    label: 'New York, NY (' + RADIUS_MILES + ' mi)' };
  const evidence = { source: 'provider adgeolocation search + delivery_estimate', checked_at: new Date().toISOString(),
    account: acct.account, city: { key: String(city.key), name: city.name, region: city.region, country_code: city.country_code, type: city.type },
    state_key_excluded: stateResult ? String(stateResult.key) : null, radius_miles: RADIUS_MILES, reach_by_radius_miles: estimates,
    min_age: ai.MIN_AGE, note: 'radius targeting around the city centre; never the state region' };

  const plan = {
    status: 'PREPARED — not launched. No provider objects exist for this market.',
    shares_global_monthly_ceiling: true,
    additional_monthly_authority_cents: 0,
    measurement: {
      market_key: 'nyc',
      separate_from_houston: 'own campaigns, own experiments, own utm_campaign; never an extra arm of a Houston experiment',
      utm_campaign_pattern: '<YYYY-MM>-individual-seller-nyc / <YYYY-MM>-professional-seller-nyc',
      utm_term_pattern: 'IS-BROAD-NYC, IS-INTENT-NYC (strategy keys)',
    },
    recommended_first_experiment: {
      funnel: 'individual_seller',
      arms: ['A-broad (IS-BROAD-NYC)', 'B-intent (IS-INTENT-NYC)'],
      creative: 'one Owner-approved package held constant across both arms (an audience test)',
      rationale: 'Repeats the Houston Individual Seller audience design in a second market so the two markets are comparable. Houston is too early to declare an arm better, so NYC does not pre-select one.',
      budget: 'authorized by the Owner at launch time from UNCOMMITTED global authority, sized by the pacing engine',
    },
    professional_seller: {
      status: 'DEFERRED',
      rationale: 'Houston Professional Seller has produced no first-party registrations or inquiries yet, its landing visits were inflated by provider review crawls, and revised Professional creative is not yet approved. Re-assess when Houston Professional Seller completes.',
    },
    launch_prerequisites: [
      'Owner sets launch_authorized for nyc',
      'NYC audience strategies created from the validated Houston strategies with the NYC geography, each re-validated by the provider',
      'fresh provider spend read and a non-blocking reconciliation state',
      'campaign authorization fits inside uncommitted global authority and the recommended daily budget maximum',
    ],
  };

  if (DRY) { console.log('\nDRY RUN — nothing written.\n' + JSON.stringify({ geoSpec, plan }, null, 2)); return 0; }

  const r = await db.query(
    `UPDATE marketing_paid_markets
        SET geo_spec = $2::jsonb, geo_validation = 'VALID', geo_evidence = $3::jsonb, geo_validated_at = now(),
            plan = $4::jsonb, updated_at = now()
      WHERE market_key = $1 AND status = 'PREPARED' AND launch_authorized = false
      RETURNING market_key, status, launch_authorized, geo_validation`,
    ['nyc', JSON.stringify(geoSpec), JSON.stringify(evidence), JSON.stringify(plan)]);
  if (!r.rowCount) { console.error('REFUSE: nyc is not a PREPARED, un-authorized market — nothing written'); return 1; }
  console.log('\nRECORDED: ' + JSON.stringify(r.rows[0]));
  return 0;
})().then((code) => db.pool.end().then(() => process.exit(code || 0)))
  .catch((e) => { console.error('ERR ' + meta.redact(e.message)); db.pool.end().then(() => process.exit(1)); });
