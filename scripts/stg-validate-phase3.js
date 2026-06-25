#!/usr/bin/env node
/*
 * stg-validate-phase3.js — STAGING-guarded validation of Phase 3 pickup tiers.
 * Sets size_category on the Phase 2D fixture lots (A,B,C,A,C) and makes ONE buyer
 * win two lots (sizes A + B) to verify "largest item wins" → assigned B. Confirms
 * getPacketData computes per-buyer assigned tier + per-lot tiers + auction tier
 * windows, and that the packet renders. Only writes test-fixture lots/invoices.
 *   railway run --service advantage-staging node scripts/stg-validate-phase3.js
 */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';
const AUC = '7d000000-0000-4000-8000-0000000000b1';
const LOTS = [11, 12, 13, 14, 15].map((n) => '7d000000-0000-4000-8000-0000000000' + n);
const SIZES = ['A', 'B', 'C', 'A', 'C'];
const BUYER1 = '7d000000-0000-4000-8000-000000000001';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not STAGING (${STG_EP}).`); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const svc = require('../src/services/pickupPacketService');
  const pt = require('../src/lib/pickupTiers');
  try {
    // Ensure the auction has a known pickup window (9:00–15:00 → A 9-11, B 11-1, C 1-3).
    await pool.query(`UPDATE auctions SET pickup_window_start = date_trunc('day', now()) + interval '9 days 9 hours', pickup_window_end = date_trunc('day', now()) + interval '9 days 15 hours' WHERE id=$1`, [AUC]);
    for (let i = 0; i < LOTS.length; i++) {
      await pool.query(`UPDATE lots SET size_category=$1 WHERE id=$2 AND auction_id=$3`, [SIZES[i], LOTS[i], AUC]);
    }
    // Make BUYER1 win lot #2 (size B) in addition to lot #1 (size A) → assigned = B.
    await pool.query(`UPDATE invoices SET buyer_user_id=$1 WHERE lot_id=$2 AND auction_id=$3`, [BUYER1, LOTS[1], AUC]);
    await pool.query(`UPDATE lots SET winning_buyer_user_id=$1 WHERE id=$2`, [BUYER1, LOTS[1]]);

    const packet = await svc.getPacketData(AUC);
    const multi = packet.invoices.filter((i) => i.buyerLots && i.buyerLots.length >= 2);
    const aBuyer = multi[0];
    const cLot = packet.invoices.find((i) => i.lotTier === 'C');
    const buf = await svc.buildPacketPdf(packet);

    const out = {
      tier_windows: packet.auction.tierWindows,
      window_thirds_ok: packet.auction.tierWindows &&
        /9:00/.test(packet.auction.tierWindows.A || '') &&
        /1:00/.test(packet.auction.tierWindows.C || ''),
      multilot_buyer_found: !!aBuyer,
      multilot_assigned_tier: aBuyer ? aBuyer.assignedTier : null,
      multilot_lots: aBuyer ? aBuyer.buyerLots.map((l) => l.tier) : null,
      largest_item_wins: aBuyer ? aBuyer.assignedTier === 'B' : false,  // A + B → B
      per_lot_tier_ok: !!cLot && cLot.lotTier === 'C' && cLot.lotTimeLabel === 'Pickup Time C',
      pdf_valid: buf.slice(0, 5).toString() === '%PDF-',
      unit_assignedTier_AAC: pt.assignedTier(['A', 'A', 'C']),
    };
    console.log('RESULT_JSON=' + JSON.stringify(out, null, 2));
    const pass = out.window_thirds_ok && out.multilot_buyer_found && out.largest_item_wins &&
      out.per_lot_tier_ok && out.pdf_valid && out.unit_assignedTier_AAC === 'C';
    console.log('RESULT: ' + (pass ? 'PASS' : 'REVIEW'));
    return pass ? 0 : 1;
  } finally { await pool.end(); }
})().then((c) => process.exit(c || 0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
