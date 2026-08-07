#!/usr/bin/env node
// READ-ONLY: reports how many professional sellers exist and how many LACK the first-sale business
// verification requirement (seller_profiles.verification_required_before_publication). No writes.
// Prints which environment it is pointed at. Use this to size migration 106 before running it.
const { Pool } = require('pg');
(async () => {
  const raw = process.env.DATABASE_URL || '';
  const env = raw.includes('ep-proud-leaf-an8pzkib') ? 'PROD' : raw.includes('ep-royal-dawn-anarou3f') ? 'STAGING' : 'OTHER';
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  try {
    const q = `
      SELECT
        count(*) FILTER (WHERE seller_type IN ('auction_house','estate_sale_company','professional_liquidator'))                                   AS professionals,
        count(*) FILTER (WHERE seller_type IN ('auction_house','estate_sale_company','professional_liquidator')
                           AND verification_required_before_publication IS DISTINCT FROM true)                                                       AS professionals_unflagged,
        count(*) FILTER (WHERE seller_type IN ('auction_house','estate_sale_company','professional_liquidator')
                           AND verification_required_before_publication IS DISTINCT FROM true
                           AND NOT EXISTS (SELECT 1 FROM verification_requests vr
                                            WHERE vr.seller_profile_id = sp.id AND vr.status='approved'))                                            AS would_backfill
      FROM seller_profiles sp`;
    const r = (await pool.query(q)).rows[0];
    const byType = (await pool.query(
      `SELECT seller_type,
              count(*)::int AS total,
              count(*) FILTER (WHERE verification_required_before_publication IS DISTINCT FROM true)::int AS unflagged
         FROM seller_profiles
        WHERE seller_type IN ('auction_house','estate_sale_company','professional_liquidator')
        GROUP BY seller_type ORDER BY seller_type`)).rows;
    console.log('PROVERIFY=' + JSON.stringify({
      env,
      professionals: Number(r.professionals),
      professionals_unflagged: Number(r.professionals_unflagged),
      would_backfill_by_migration_106: Number(r.would_backfill),
      by_type: byType,
    }, null, 2));
  } finally { await pool.end(); }
})().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
