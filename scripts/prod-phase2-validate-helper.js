#!/usr/bin/env node
/*
 * prod-phase2-validate-helper.js — PRODUCTION-guarded, READ-ONLY helper for the
 * Phase 2 promotion validation. Lists existing invoices (to choose a safe email
 * target) and mints admin + buyer JWTs for the live admin/buyer checks. No writes.
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-phase2-validate-helper.js
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: STAGING endpoint.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: not PRODUCTION endpoint.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  try {
    const rows = (await pool.query(
      `SELECT i.id, i.invoice_number, i.status, i.buyer_user_id, i.auction_id,
              u.email AS buyer_email, p.status AS payment_status
         FROM invoices i
         LEFT JOIN users u ON u.id = i.buyer_user_id
         LEFT JOIN payments p ON p.id = i.payment_id
        ORDER BY i.created_at DESC`
    )).rows;
    let baseUrl = ''; try { baseUrl = require('../src/lib/publicUrls').publicBaseUrl(); } catch (_e) {}
    const buyers = [...new Set(rows.map(r => r.buyer_user_id).filter(Boolean))];
    const out = {
      base_url: baseUrl || '(unset)',
      invoice_count: rows.length,
      inventory: rows.map(r => ({ id: r.id, num: r.invoice_number, status: r.status, paid: r.status === 'paid' || r.payment_status === 'paid', email: r.buyer_email, auction_id: r.auction_id })),
      admin_jwt: jwt.sign({ id: '00000000-0000-4000-8000-0000000000ad', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '2h' }),
      buyer_jwt_for_first: rows[0] ? jwt.sign({ id: rows[0].buyer_user_id, role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '2h' }) : null,
      first_invoice_id: rows[0] ? rows[0].id : null,
      first_auction_id: rows[0] ? rows[0].auction_id : null,
      // an invoice owned by a DIFFERENT buyer than the first (for the ownership-negative test)
      other_invoice_id: (rows.find(r => rows[0] && r.buyer_user_id !== rows[0].buyer_user_id) || {}).id || null,
    };
    console.log('PVAL_JSON=' + JSON.stringify(out));
  } finally { await pool.end(); }
})().then(c => process.exit(c || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
