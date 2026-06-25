#!/usr/bin/env node
/*
 * stg-validate-tz-entry.js — STAGING-guarded end-to-end round-trip: simulate a
 * seller entering 9:00 AM–3:00 PM in a chosen auction timezone (via timezoneUtils
 * .localToUtcIso, the SAME logic the browser helper uses), store the UTC instant on
 * fixture auction 7d…b1, then confirm getPacketData displays it as 9:00 AM–3:00 PM
 * in that timezone. Proves entry→store→display. Only writes the fixture auction.
 *   railway run --service advantage-staging node scripts/stg-validate-tz-entry.js
 */
const { Pool } = require('pg');
const tu = require('../src/lib/timezoneUtils');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';
const AUC = '7d000000-0000-4000-8000-0000000000b1';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not STAGING (${STG_EP}).`); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const svc = require('../src/services/pickupPacketService');
  const out = {};
  try {
    for (const tz of ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']) {
      const startUtc = tu.localToUtcIso('2026-07-18T09:00', tz);  // seller types 9:00 AM in auction tz
      const endUtc = tu.localToUtcIso('2026-07-18T15:00', tz);    // ...3:00 PM
      await pool.query(`UPDATE auctions SET timezone=$1, pickup_window_start=$2, pickup_window_end=$3 WHERE id=$4`, [tz, startUtc, endUtc, AUC]);
      const packet = await svc.getPacketData(AUC);
      const A = packet.auction.tierWindows.A, C = packet.auction.tierWindows.C;
      const ok = /^9:00\s*AM/.test(A) && /3:00\s*PM$/.test(C);
      out[tz] = { storedStartUtc: startUtc, displayA: A, displayC: C, ok };
    }
    // DST winter case: January 9 AM Eastern (EST) must still display 9:00 AM
    const janStart = tu.localToUtcIso('2026-01-18T09:00', 'America/New_York');
    const janEnd = tu.localToUtcIso('2026-01-18T15:00', 'America/New_York');
    await pool.query(`UPDATE auctions SET timezone='America/New_York', pickup_window_start=$1, pickup_window_end=$2 WHERE id=$3`, [janStart, janEnd, AUC]);
    const janPacket = await svc.getPacketData(AUC);
    out.dst_january = { storedStartUtc: janStart, displayA: janPacket.auction.tierWindows.A, ok: /^9:00\s*AM/.test(janPacket.auction.tierWindows.A) && new Date(janStart).getUTCHours() === 14 };

    console.log('RESULT_JSON=' + JSON.stringify(out, null, 2));
    const pass = Object.values(out).every((v) => v.ok);
    console.log('RESULT: ' + (pass ? 'PASS' : 'REVIEW'));
    return pass ? 0 : 1;
  } finally { await pool.end(); }
})().then((c) => process.exit(c || 0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
