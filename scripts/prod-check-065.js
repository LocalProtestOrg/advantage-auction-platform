#!/usr/bin/env node
/*
 * prod-check-065.js — READ-ONLY status check for migration 065. SELECT-only;
 * applies nothing, changes nothing. Safe on any endpoint (use it on prod to
 * confirm the "before" state, and after apply to confirm "after").
 *
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-check-065.js
 */
const { Pool } = require('pg');

const FILE = '065_notification_queue_lease.sql';
const NEW_COLS = ['next_attempt_at', 'locked_at', 'last_error', 'processed_at'];
const INDEXES  = ['idx_notifications_queue_ready', 'idx_notifications_queue_processing'];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set'); return 2; }
  const endpoint = raw.includes('ep-proud-leaf-an8pzkib') ? 'PRODUCTION'
    : raw.includes('ep-royal-dawn-anarou3f') ? 'staging' : 'unknown';
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const db = (await c.query('SELECT current_database() d')).rows[0].d;
    const recorded = (await c.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [FILE])).rowCount > 0;
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='notifications_queue' AND column_name = ANY($1)`, [NEW_COLS])).rows.map(r => r.column_name);
    const ck = (await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='notifications_queue_status_check'`)).rows[0];
    const idx = (await c.query(`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`, [INDEXES])).rows.map(r => r.indexname);
    const ckOk = !!ck && ck.d.includes("'processing'") && ck.d.includes("'skipped'");
    const applied = recorded && cols.length === 4 && ckOk && idx.length === 2;
    console.log('-'.repeat(60));
    console.log(`065 status check — db=${db} endpoint=${endpoint} (READ-ONLY)`);
    console.log('-'.repeat(60));
    console.log('schema_migrations[065] : ' + (recorded ? 'recorded' : 'NOT recorded'));
    console.log('new columns            : ' + cols.length + '/4 ' + JSON.stringify(cols));
    console.log('status CHECK           : ' + (ck ? ck.d : '(none)'));
    console.log('indexes                : ' + idx.length + '/2 ' + JSON.stringify(idx));
    console.log('-'.repeat(60));
    console.log('VERDICT: 065 is ' + (applied ? 'APPLIED' : 'PENDING (not fully applied)'));
    return 0;
  } catch (e) { console.error('ERR', e.message); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
