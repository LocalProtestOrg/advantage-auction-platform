#!/usr/bin/env node
/*
 * stg-validate-phase2e.js — STAGING-guarded helper for the Phase 2E (Auction
 * Invoices module) UX validation. Read-only: picks an existing invoice + mints
 * admin/buyer JWTs so the live page + endpoint checks can run against staging.
 * No data changes.
 *   railway run --service advantage-staging node scripts/stg-validate-phase2e.js
 */
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const PROD_EP = 'ep-proud-leaf-an8pzkib';
const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint.'); return 2; }
  if (!raw.includes(STG_EP)) { console.error(`REFUSE: not STAGING (${STG_EP}).`); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  try {
    // Prefer the Phase 2D fixture auction; fall back to any auction that has invoices.
    let inv = (await pool.query(
      `SELECT id, buyer_user_id, auction_id FROM invoices WHERE auction_id = '7d000000-0000-4000-8000-0000000000b1' LIMIT 1`
    )).rows[0];
    if (!inv) inv = (await pool.query(`SELECT id, buyer_user_id, auction_id FROM invoices ORDER BY created_at DESC LIMIT 1`)).rows[0];
    let baseUrl = ''; try { baseUrl = require('../src/lib/publicUrls').publicBaseUrl(); } catch (_e) {}
    console.log('RESULT_JSON=' + JSON.stringify({
      base_url: baseUrl || '(unset)',
      invoice_id: inv ? inv.id : null,
      auction_id: inv ? inv.auction_id : null,
      admin_jwt: jwt.sign({ id: '7d000000-0000-4000-8000-0000000000ad', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
      buyer_jwt: jwt.sign({ id: inv ? inv.buyer_user_id : '00000000-0000-4000-8000-000000000000', role: 'buyer' }, process.env.JWT_SECRET, { expiresIn: '1h' }),
    }));
  } finally { await pool.end(); }
})().then((c) => process.exit(c || 0)).catch((e) => { console.error('FATAL', e.message); process.exit(1); });
