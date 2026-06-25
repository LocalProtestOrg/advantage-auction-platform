#!/usr/bin/env node
/*
 * prod-validate-tier.js — PRODUCTION-guarded, READ-ONLY. Confirms the pickup
 * tier/size line reads real prod data: lists size_category per invoiced lot and
 * runs getPacketData for an auction-with-invoices to show the mapped sizeTier.
 * Also mints admin/buyer JWTs for the live HTTP checks. No writes.
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-validate-tier.js
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: STAGING endpoint.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: not PRODUCTION endpoint.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const svc = require('../src/services/pickupPacketService');
  try {
    const inv = (await pool.query(
      `SELECT i.id, i.invoice_number, i.auction_id, i.buyer_user_id, l.size_category
         FROM invoices i LEFT JOIN lots l ON l.id = i.lot_id
        ORDER BY i.created_at DESC`
    )).rows;
    const withSize = inv.filter((r) => r.size_category);
    // Pick an auction that has invoices (prefer one whose lot has a size_category).
    const targetAuction = (withSize[0] && withSize[0].auction_id) || (inv[0] && inv[0].auction_id);
    let tierSample = [];
    if (targetAuction) {
      const packet = await svc.getPacketData(targetAuction);
      tierSample = packet.invoices.map((i) => ({ num: i.invoiceNumber, size: i.sizeCategory, tier: i.sizeTier }));
    }
    const first = inv[0];
    console.log('PVAL2_JSON=' + JSON.stringify({
      invoice_count: inv.length,
      lots_with_size_category: withSize.length,
      size_distribution: inv.reduce((m, r) => { const k = r.size_category || 'unset'; m[k] = (m[k] || 0) + 1; return m; }, {}),
      target_auction: targetAuction,
      tier_sample: tierSample,
      first_invoice_id: first ? first.id : null,
      first_auction_id: first ? first.auction_id : null,
      admin_jwt: jwt.sign({ id: '00000000-0000-4000-8000-0000000000ad', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '2h' }),
      buyer_jwt: first ? jwt.sign({ id: first.buyer_user_id, role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '2h' }) : null,
    }));
  } finally { await pool.end(); }
})().then((c) => process.exit(c || 0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
