#!/usr/bin/env node
/* Register the Lewis & Maese (lmauctionco.com) source + run a gentle ingestion via the real pipeline.
 * OWNER-AUTHORIZED source. Idempotent. Usage: railway run node scripts/register-lmauction-source.js [--ingest] */
const { Pool } = require('pg');
const KEY = 'lmauction-lewis-maese';
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const db = await pool.connect();
  try {
    const owner = (await db.query("SELECT owner_organization_id FROM import_sources WHERE key='gsa-auctions' OR owner_organization_id IS NOT NULL LIMIT 1")).rows[0];
    if (!owner) throw new Error('no existing source to copy owner_organization_id from');
    await db.query(
      `INSERT INTO import_sources (key, kind, name, status, config, weekly_cap, auto_publish, media_policy, owner_organization_id)
       VALUES ($1,'rest',$2,'active',$3::jsonb,$4,true,'mirror',$5)
       ON CONFLICT (key) DO UPDATE SET status='active', config=EXCLUDED.config, weekly_cap=EXCLUDED.weekly_cap,
         auto_publish=true, media_policy='mirror', updated_at=now()`,
      [KEY, 'Lewis & Maese Auction Co. (Houston, TX)',
       JSON.stringify({ connector: 'lmauction', cap: 25, timezone: 'America/Chicago' }), 25, owner.owner_organization_id]);
    console.log('SOURCE_REGISTERED=' + KEY);
  } finally { db.release(); await pool.end(); }

  if (process.argv.includes('--ingest')) {
    const { runImport } = require('../src/services/eventImport');
    const { withTransaction } = require('../src/utils/withTransaction');
    const r = await runImport({ sourceKey: KEY, apply: true, trigger: 'manual', withTransaction });
    console.log('INGEST=' + JSON.stringify(r && r.counters ? r.counters : r));
  }
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
