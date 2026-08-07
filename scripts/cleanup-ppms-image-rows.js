#!/usr/bin/env node
/**
 * cleanup-ppms-image-rows.js — one-time data correction for the Map View image regression.
 *
 * PROBLEM: imported GSA auction events stored a cover image URL pointing at the authenticated PPMS image
 * API (www.ppms.gov/gw/auction/ppms/api/…), which returns HTTP 401 to the public. These URLs cannot be
 * displayed on the marketplace — each renders as a broken/empty tile plus a wasted 401 request. The GSA
 * connector fix stops ingesting them going forward; this removes the ones already stored so the affected
 * event cards cleanly use the branded placeholder fallback.
 *
 * SAFETY: deletes ONLY event_images rows whose url host is ppms.gov. It does NOT touch the events
 * themselves, any other image host, or any other table. DRY-RUN BY DEFAULT — prints the affected count and
 * a sample and exits. Pass --apply to perform the delete. Prints which environment it is pointed at.
 *
 *   node scripts/cleanup-ppms-image-rows.js            # dry run (no writes)
 *   node scripts/cleanup-ppms-image-rows.js --apply    # perform the delete (owner-approved only)
 */
const { Pool } = require('pg');
(async () => {
  const apply = process.argv.includes('--apply');
  const raw = process.env.DATABASE_URL || '';
  const env = raw.includes('ep-proud-leaf-an8pzkib') ? 'PROD' : raw.includes('ep-royal-dawn-anarou3f') ? 'STAGING' : 'OTHER';
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const MATCH = "url ILIKE 'http://www.ppms.gov/%' OR url ILIKE 'https://www.ppms.gov/%' OR url ILIKE 'http://ppms.gov/%' OR url ILIKE 'https://ppms.gov/%'";
  try {
    const before = (await pool.query(
      `SELECT count(*)::int AS rows, count(DISTINCT event_id)::int AS events FROM event_images WHERE ${MATCH}`)).rows[0];
    const sample = (await pool.query(`SELECT event_id, url FROM event_images WHERE ${MATCH} LIMIT 3`)).rows;
    console.log(`[cleanup-ppms] env=${env} matched rows=${before.rows} events=${before.events} apply=${apply}`);
    console.log('[cleanup-ppms] sample:', JSON.stringify(sample));
    if (!apply) { console.log('[cleanup-ppms] DRY RUN — no rows deleted. Re-run with --apply to delete.'); return; }
    const del = await pool.query(`DELETE FROM event_images WHERE ${MATCH}`);
    console.log(`[cleanup-ppms] DELETED ${del.rowCount} event_images row(s). Affected events now fall back to the branded placeholder.`);
  } finally { await pool.end(); }
})().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
