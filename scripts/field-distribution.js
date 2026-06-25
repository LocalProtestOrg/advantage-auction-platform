#!/usr/bin/env node
// READ-ONLY: counts lots by size_category vs pickup_category to inform which field
// drives pickup. Endpoint-agnostic (prints which env). No writes.
const { Pool } = require('pg');
(async () => {
  const raw = process.env.DATABASE_URL || '';
  const env = raw.includes('ep-proud-leaf-an8pzkib') ? 'PROD' : raw.includes('ep-royal-dawn-anarou3f') ? 'STAGING' : 'OTHER';
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  try {
    const total = (await pool.query('SELECT count(*)::int n FROM lots')).rows[0].n;
    const sizeDist = (await pool.query(`SELECT COALESCE(size_category,'(null)') k, count(*)::int n FROM lots GROUP BY 1 ORDER BY 1`)).rows;
    const pickupDist = (await pool.query(`SELECT COALESCE(pickup_category,'(null)') k, count(*)::int n FROM lots GROUP BY 1 ORDER BY 1`)).rows;
    const bothSet = (await pool.query(`SELECT count(*)::int n FROM lots WHERE size_category IS NOT NULL AND pickup_category IS NOT NULL`)).rows[0].n;
    const agree = (await pool.query(`SELECT count(*)::int n FROM lots WHERE size_category IS NOT NULL AND pickup_category IS NOT NULL AND size_category = pickup_category`)).rows[0].n;
    console.log('FIELDDIST=' + JSON.stringify({ env, total_lots: total, size_category: sizeDist, pickup_category: pickupDist, both_set: bothSet, both_set_and_equal: agree }));
  } finally { await pool.end(); }
})().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
