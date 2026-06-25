#!/usr/bin/env node
/*
 * stg-validate-tz.js — STAGING-guarded validation of auction-timezone pickup display.
 * Uses fixture auction 7d…b1 (window 13:00–19:00Z → 9 AM–3 PM Eastern). Verifies
 * getPacketData formats tier windows in the auction timezone: Eastern → 9 AM start,
 * Central → 8 AM start, NULL → Eastern fallback. Verifies createAuction stores
 * timezone. Only writes the test-fixture auction (+ a temp draft it deletes).
 *   railway run --service advantage-staging node scripts/stg-validate-tz.js
 */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';
const AUC = '7d000000-0000-4000-8000-0000000000b1';
const WIN_START = '2026-07-15T13:00:00Z';   // 9:00 AM Eastern (EDT, UTC-4)
const WIN_END = '2026-07-15T19:00:00Z';      // 3:00 PM Eastern

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not STAGING (${STG_EP}).`); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const svc = require('../src/services/pickupPacketService');
  const auctionService = require('../src/services/auctionService');
  const out = {};
  try {
    await pool.query(`UPDATE auctions SET pickup_window_start=$1, pickup_window_end=$2 WHERE id=$3`, [WIN_START, WIN_END, AUC]);
    const tierA = async () => (await svc.getPacketData(AUC)).auction.tierWindows.A;

    await pool.query(`UPDATE auctions SET timezone='America/New_York' WHERE id=$1`, [AUC]);
    out.eastern_A = await tierA();
    await pool.query(`UPDATE auctions SET timezone='America/Chicago' WHERE id=$1`, [AUC]);
    out.central_A = await tierA();
    await pool.query(`UPDATE auctions SET timezone=NULL WHERE id=$1`, [AUC]);
    out.nulltz_A = await tierA();
    // Restore a sensible value on the fixture.
    await pool.query(`UPDATE auctions SET timezone='America/New_York' WHERE id=$1`, [AUC]);

    // createAuction stores timezone
    const sp = (await pool.query(`SELECT id FROM seller_profiles LIMIT 1`)).rows[0];
    let createdTz = null, createdId = null;
    if (sp) {
      const created = await auctionService.createAuction({ sellerId: sp.id, title: 'TZ validate (temp)', state: 'draft', timezone: 'America/Denver' });
      createdTz = created.timezone; createdId = created.id;
      await pool.query(`DELETE FROM auctions WHERE id=$1`, [createdId]); // clean up temp draft
    }
    out.createAuction_stored_tz = createdTz;

    out.eastern_ok = /9:00\s*AM/.test(out.eastern_A || '');
    out.central_ok = /8:00\s*AM/.test(out.central_A || '');     // 1 hour earlier than Eastern
    out.nulltz_fallback_eastern_ok = /9:00\s*AM/.test(out.nulltz_A || '');
    out.create_ok = out.createAuction_stored_tz === 'America/Denver';

    console.log('RESULT_JSON=' + JSON.stringify(out, null, 2));
    const pass = out.eastern_ok && out.central_ok && out.nulltz_fallback_eastern_ok && out.create_ok;
    console.log('RESULT: ' + (pass ? 'PASS' : 'REVIEW'));
    return pass ? 0 : 1;
  } finally { await pool.end(); }
})().then((c) => process.exit(c || 0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
