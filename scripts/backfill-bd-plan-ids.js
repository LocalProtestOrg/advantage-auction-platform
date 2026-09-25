#!/usr/bin/env node
/* backfill-bd-plan-ids.js — record each directory listing's plan id in organizations.bd_metadata.subscription_id.

   The nightly directory sync writes this key from now on (bdDirectoryService.normalize → metaFor); this
   one-off fills it now so the Claimed Listing paid-member rule does not have to wait for the next sync.
   Reads the directory with the existing read-only REST transport. Writes ONLY the one jsonb key, on rows
   matched by bd_listing_id; no other column and no directory record is touched.

   Dry run (default):  railway run node scripts/backfill-bd-plan-ids.js
   Apply:              railway run node scripts/backfill-bd-plan-ids.js --apply
*/
const path = require('path');
if (!process.env.BD_API_KEY) require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const bd = require('../src/services/bdRestTransport');

(async () => {
  const apply = process.argv.includes('--apply');
  if (!process.env.DATABASE_URL) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  const { records, total } = await bd.fetchAllListings();
  if (!records.length || records.length < total) { console.error('REFUSE: incomplete directory read (' + records.length + ' of ' + total + ').'); return 1; }
  const plans = new Map(records.filter((r) => r.user_id != null && r.subscription_id != null).map((r) => [String(r.user_id), String(r.subscription_id).trim()]));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  try {
    const orgs = (await pool.query(`SELECT id, bd_listing_id, bd_metadata->>'subscription_id' AS plan FROM organizations WHERE bd_listing_id IS NOT NULL`)).rows;
    const changes = orgs.filter((o) => plans.has(String(o.bd_listing_id)) && plans.get(String(o.bd_listing_id)) !== o.plan);
    const byPlan = changes.reduce((m, o) => { const p = plans.get(String(o.bd_listing_id)); m[p] = (m[p] || 0) + 1; return m; }, {});
    console.log(JSON.stringify({ directory_records: records.length, organizations_with_listing_id: orgs.length, to_update: changes.length, by_plan: byPlan,
      not_in_directory: orgs.filter((o) => !plans.has(String(o.bd_listing_id))).length, mode: apply ? 'APPLY' : 'DRY RUN' }));
    if (!apply) return 0;
    let n = 0;
    for (const o of changes) {
      const r = await pool.query(
        `UPDATE organizations SET bd_metadata = jsonb_set(COALESCE(bd_metadata, '{}'::jsonb), '{subscription_id}', to_jsonb($2::text)) WHERE id = $1 AND bd_listing_id = $3`,
        [o.id, plans.get(String(o.bd_listing_id)), o.bd_listing_id]);
      n += r.rowCount;
    }
    console.log('UPDATED ' + n + ' rows (bd_metadata.subscription_id only).');
    return 0;
  } finally { await pool.end(); }
})().then((c) => process.exit(c || 0)).catch((e) => { console.error(e.message); process.exit(1); });
