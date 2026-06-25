#!/usr/bin/env node
/*
 * stg-validate-phase2f.js — STAGING-guarded validation of the pickup-tier/size
 * line on the Pickup Release packet. Sets size_category on ONE fixture lot, then
 * confirms getPacketData maps it to the authoritative Lot Studio label and that
 * unset lots read "Not specified". Renders the packet to confirm it builds.
 * Only writes size_category on a labeled test-fixture lot (7d…11). No other writes.
 *   railway run --service advantage-staging node scripts/stg-validate-phase2f.js
 */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';
const AUCTION_ID = '7d000000-0000-4000-8000-0000000000b1';
const LOT_ID = '7d000000-0000-4000-8000-000000000011';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not STAGING (${STG_EP}).`); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const svc = require('../src/services/pickupPacketService');
  try {
    // Set a size on one fixture lot (B = Medium). Harmless test-fixture write.
    const upd = await pool.query(`UPDATE lots SET size_category='B' WHERE id=$1 AND auction_id=$2`, [LOT_ID, AUCTION_ID]);
    const packet = await svc.getPacketData(AUCTION_ID);
    if (!packet) { console.error('no packet'); return 1; }
    const tiers = packet.invoices.map((i) => ({ lot: i.lotNumber, title: i.lotTitle, size: i.sizeCategory, tier: i.sizeTier }));
    const labeled = packet.invoices.find((i) => i.sizeCategory === 'B');
    const buf = await svc.buildPacketPdf(packet);
    const out = {
      fixture_lot_updated: upd.rowCount,
      labeled_tier_ok: !!labeled && labeled.sizeTier === 'B — Medium (2 people)',
      has_not_specified: packet.invoices.some((i) => i.sizeTier === 'Not specified'),
      pdf_valid: buf.slice(0, 5).toString() === '%PDF-',
      tiers,
    };
    console.log('RESULT_JSON=' + JSON.stringify(out, null, 2));
    const pass = out.labeled_tier_ok && out.pdf_valid;
    console.log('RESULT: ' + (pass ? 'PASS' : 'REVIEW'));
    return pass ? 0 : 1;
  } finally { await pool.end(); }
})().then((c) => process.exit(c || 0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
