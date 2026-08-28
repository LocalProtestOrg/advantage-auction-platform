#!/usr/bin/env node
/*
 * verify-google-places.js — safe, controlled verification of Google Places API (New).
 * Reads GOOGLE_PLACES_API_KEY ONLY from the server environment; NEVER prints/logs the key.
 * Makes ONE inexpensive searchText request (minimal field mask) and reports whether real results come back.
 *   railway run node scripts/verify-google-places.js ["optional test query"]
 * Exit 0 = OK, 2 = key/config problem, 1 = other error.
 */
const gp = require('../src/services/prospectResearch/googlePlaces');

(async () => {
  if (!gp.hasApiKey()) { console.log('MISSING_KEY: GOOGLE_PLACES_API_KEY is not set in this environment.'); process.exit(2); }
  console.log('KEY_PRESENT=true'); // presence only — never the value
  const query = process.argv[2] || 'estate sale company in Adrian Michigan';
  const r = await gp.searchText(query, { max: 5 });
  if (!r.ok) {
    console.log('HTTP=' + r.status + ' DIAGNOSIS=' + r.diagnosis);
    console.log('DETAIL=' + (r.message || '').slice(0, 400));
    process.exit(2);
  }
  console.log('HTTP=200 RESULTS=' + r.places.length + ' (query: "' + query + '")');
  r.places.slice(0, 5).forEach((p) => console.log('  ' + JSON.stringify({
    name: p.displayName, city: p.city, state: p.state, phone: p.phone || null, website: p.website || null,
    place_id: (p.googlePlaceId || '').slice(0, 10) + '…', types: (p.types || []).slice(0, 4),
  })));
  console.log('RESULT: ' + (r.places.length > 0 ? 'PASS' : 'PASS (no results for this test query, but API works)'));
  process.exit(0);
})().catch((e) => { console.log('FETCH_ERR=' + e.message); process.exit(1); });
