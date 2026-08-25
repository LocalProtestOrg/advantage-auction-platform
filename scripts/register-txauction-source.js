#!/usr/bin/env node
/* Register the txauction (Gaston & Sheehan) source + run a gentle ingestion via the real pipeline.
 * Idempotent. Usage: railway run node scripts/register-txauction-source.js [--ingest] */
const { Pool } = require('pg');
const KEY = 'txauction-gov';
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
      [KEY, 'Gaston & Sheehan Auctioneers (Treasury / US Marshals / Local Government Auctions)',
       JSON.stringify({ connector: 'txauction', cap: 15, timezone: 'America/Chicago' }), 40, owner.owner_organization_id]);
    console.log('SOURCE_REGISTERED=' + KEY);
  } finally { db.release(); await pool.end(); }

  if (process.argv.includes('--ingest')) {
    const { runImport } = require('../src/services/eventImport');
    const { withTransaction } = require('../src/utils/withTransaction');
    const r = await runImport({ sourceKey: KEY, apply: true, trigger: 'manual', withTransaction });
    console.log('INGEST=' + JSON.stringify(r && r.counters ? r.counters : r));
  }
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
