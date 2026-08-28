#!/usr/bin/env node
/*
 * research-prospects-google.js — nationwide prospect discovery via Google Places API (New).
 *
 * COST-CONTROLLED + INCREMENTAL + RESUMABLE. Iterates (query term × US state) "cells"; each cell is one
 * (occasionally paginated) Text Search. Cells already searched within REFRESH_AGE_DAYS are SKIPPED
 * (checkpoint table prospect_research_queries) so an interrupted/repeat run never re-bills completed work.
 * Hard caps (--max-queries, --max-new) bound every run. Results are deduped (Place ID → domain → phone →
 * name+city+state) and imported via salesProspectService.importProspects, which updates ONLY research
 * fields and NEVER overwrites Sales activity. New prospects start UNASSIGNED. Run stats → prospect_research_runs.
 *
 * The API key is read only from process.env.GOOGLE_PLACES_API_KEY (never printed/logged/stored).
 *
 *   railway run node scripts/research-prospects-google.js --plan                 # print the plan, NO API calls
 *   railway run node scripts/research-prospects-google.js --max-queries=8 --max-new=50   # controlled first batch
 *   railway run node scripts/research-prospects-google.js --max-queries=60      # a bounded nationwide slice
 * Flags: --states=MI,OH  --terms="estate sale company,auction house"  --paginate  --refresh-days=30
 */
const { Pool } = require('pg');
const gp = require('../src/services/prospectResearch/googlePlaces');
const svc = require('../src/services/salesProspectService');
const profileSchema = require('../src/lib/professionalProfileSchema');

const arg = (name, def) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.split('=').slice(1).join('=') : def; };
const flag = (name) => process.argv.includes('--' + name);

const PLAN = flag('plan');
const MAX_QUERIES = parseInt(arg('max-queries', '60'), 10);
const MAX_NEW = parseInt(arg('max-new', '300'), 10);
const REFRESH_DAYS = parseInt(arg('refresh-days', '30'), 10);
const PAGINATE = flag('paginate');
const DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_TERMS = ['estate sale company', 'estate liquidator', 'estate auction', 'auction house'];
const TERMS = (arg('terms', '') ? arg('terms', '').split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TERMS);
const STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'Washington DC', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const STATES = (arg('states', '') ? arg('states', '').split(',').map((s) => s.trim().toUpperCase()) : profileSchema.US_STATES);

(async () => {
  if (!gp.hasApiKey()) { console.log('MISSING_KEY: GOOGLE_PLACES_API_KEY not set. Aborting (no API calls).'); process.exit(2); }

  // Build the cell plan (term × state).
  const cells = [];
  for (const st of STATES) { const name = STATE_NAMES[st]; if (!name) continue; for (const term of TERMS) cells.push({ st, term, query: `${term} in ${name}`, key: `google_places|${term}|${st}` }); }
  console.log(`PLAN: ${cells.length} candidate cells (${TERMS.length} terms × ${STATES.length} states); caps: max-queries=${MAX_QUERIES}, max-new=${MAX_NEW}, refresh-days=${REFRESH_DAYS}, paginate=${PAGINATE}`);
  if (PLAN) { cells.slice(0, 8).forEach((c) => console.log('  e.g. ' + c.query)); console.log('(--plan: no API calls made)'); return; }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const db = await pool.connect();
  // Route the shared db module through this client so svc.importProspects hits prod.
  const dbmod = require('../src/db'); const origQuery = dbmod.query; dbmod.query = (t, p) => db.query(t, p);

  const stats = { queries_made: 0, api_requests: 0, results_received: 0, inserted: 0, enriched: 0, duplicates: 0, skipped_irrelevant: 0, skipped_no_contact: 0, actionable_new: 0, api_errors: 0 };
  const statesCovered = {};
  const run = (await db.query(`INSERT INTO prospect_research_runs (source, status) VALUES ('google_places','running') RETURNING id`)).rows[0];
  let stopReason = 'completed';
  try {
    for (const cell of cells) {
      if (stats.queries_made >= MAX_QUERIES) { stopReason = 'stopped'; break; }
      if (stats.inserted >= MAX_NEW) { stopReason = 'stopped'; break; }
      // Checkpoint / refresh-age: skip cells searched recently.
      const seen = (await db.query(`SELECT last_run_at FROM prospect_research_queries WHERE query_key=$1 AND last_run_at > now() - ($2 || ' days')::interval`, [cell.key, String(REFRESH_DAYS)])).rows[0];
      if (seen) continue;

      const r = await gp.searchText(cell.query, { max: PAGINATE ? 60 : 20, paginate: PAGINATE });
      stats.queries_made++; stats.api_requests += (r.requests || 0);
      if (!r.ok) {
        stats.api_errors++;
        console.log(`ERR ${cell.query} -> HTTP ${r.status} ${r.diagnosis}`);
        if (r.status === 429) { stopReason = 'stopped'; break; }         // back off the whole run on quota
        if (r.status === 403) { stopReason = 'failed'; break; }          // config problem — stop
        await sleep(DELAY_MS); continue;
      }
      stats.results_received += r.places.length;
      // Map → relevance filter → in-batch de-dup by place id.
      const seenPid = new Set(); const recs = [];
      for (const place of r.places) {
        const rec = gp.toProspect(place);
        if (!rec._relevant) { stats.skipped_irrelevant++; continue; }
        if (rec.google_place_id) { if (seenPid.has(rec.google_place_id)) continue; seenPid.add(rec.google_place_id); }
        recs.push(rec);
      }
      const before = stats.inserted;
      const sum = await svc.importProspects(recs, { source: 'google_places', requireContact: true });
      stats.inserted += sum.inserted; stats.enriched += sum.updated; stats.duplicates += sum.skipped_duplicate; stats.skipped_no_contact += sum.skipped_no_contact;
      stats.actionable_new += sum.inserted;                              // importProspects only inserts actionable (phone/email)
      if (sum.inserted > 0) statesCovered[cell.st] = (statesCovered[cell.st] || 0) + sum.inserted;
      await db.query(`INSERT INTO prospect_research_queries (query_key, source, query_text, state, results_count, new_count)
        VALUES ($1,'google_places',$2,$3,$4,$5) ON CONFLICT (query_key) DO UPDATE SET last_run_at=now(), results_count=EXCLUDED.results_count, new_count=EXCLUDED.new_count`,
        [cell.key, cell.query, cell.st, r.places.length, sum.inserted]);
      console.log(`${cell.st} "${cell.term}": ${r.places.length} results → +${sum.inserted} new, ${sum.updated} enriched, ${sum.skipped_duplicate} dup, ${sum.skipped_no_contact} no-contact (total new this run: ${stats.inserted})`);
      await sleep(DELAY_MS);
    }
  } catch (e) { stopReason = 'failed'; console.log('FATAL ' + e.message); }
  finally {
    await db.query(`UPDATE prospect_research_runs SET finished_at=now(), status=$2, queries_made=$3, api_requests=$4, results_received=$5,
      inserted=$6, enriched=$7, duplicates=$8, skipped_irrelevant=$9, skipped_no_contact=$10, actionable_new=$11, api_errors=$12, states=$13 WHERE id=$1`,
      [run.id, stopReason, stats.queries_made, stats.api_requests, stats.results_received, stats.inserted, stats.enriched, stats.duplicates, stats.skipped_irrelevant, stats.skipped_no_contact, stats.actionable_new, stats.api_errors, JSON.stringify(statesCovered)]);
    dbmod.query = origQuery; db.release(); await pool.end();
  }
  console.log('RUN_DONE status=' + stopReason + ' ' + JSON.stringify(stats));
  console.log('STATES=' + JSON.stringify(statesCovered));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
