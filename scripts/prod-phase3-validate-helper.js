#!/usr/bin/env node
/*
 * prod-phase3-validate-helper.js — PRODUCTION-guarded, READ-ONLY. Finds prod lots
 * with size_category A/B/C (for the lot-page checks), a prod auction with invoices
 * + a pickup window (for the packet/auction-page checks), and mints admin/buyer
 * JWTs. No writes.
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-phase3-validate-helper.js
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: STAGING.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: not PRODUCTION.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  try {
    const pickLot = async (s) => (await pool.query(
      `SELECT l.id, l.size_category FROM lots l JOIN auctions a ON a.id=l.auction_id
        WHERE l.size_category=$1 AND a.is_archived IS NOT TRUE AND l.state<>'withdrawn' LIMIT 1`, [s]
    )).rows[0];
    const lotA = await pickLot('A'), lotB = await pickLot('B'), lotC = await pickLot('C');
    // An auction that has invoices AND a pickup window (best case for packet + auction-page checks).
    const auc = (await pool.query(
      `SELECT a.id, a.pickup_window_start FROM auctions a
        WHERE a.pickup_window_start IS NOT NULL AND a.pickup_window_end IS NOT NULL
          AND EXISTS (SELECT 1 FROM invoices i WHERE i.auction_id=a.id) LIMIT 1`
    )).rows[0];
    const aucAny = auc || (await pool.query(`SELECT i.auction_id AS id FROM invoices i LIMIT 1`)).rows[0];
    const firstInv = (await pool.query(`SELECT id, buyer_user_id FROM invoices WHERE auction_id=$1 LIMIT 1`, [aucAny.id])).rows[0];
    console.log('P3_JSON=' + JSON.stringify({
      lotA: lotA && lotA.id, lotB: lotB && lotB.id, lotC: lotC && lotC.id,
      packet_auction: aucAny && aucAny.id, packet_auction_has_window: !!auc,
      sample_invoice: firstInv && firstInv.id,
      admin_jwt: jwt.sign({ id: '00000000-0000-4000-8000-0000000000ad', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '2h' }),
      buyer_jwt: firstInv ? jwt.sign({ id: firstInv.buyer_user_id, role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '2h' }) : null,
    }));
  } finally { await pool.end(); }
})().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
