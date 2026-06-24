#!/usr/bin/env node
/*
 * prod-preflight-phase2.js — PRODUCTION-guarded, READ-ONLY preflight for the
 * Phase 2 invoice system promotion. Mutates nothing. Reports migration state,
 * the duplicate-invoice check (gate for migration 073), schema state, Stripe mode,
 * SES config, and a scan for any LIVE Stripe keys (must be none).
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-preflight-phase2.js
 */
const { Pool } = require('pg');

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: not the PRODUCTION endpoint (ep-proud-leaf-an8pzkib).'); return 2; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  const out = {};
  try {
    out.database = (await c.query('SELECT current_database() d')).rows[0].d;
    out.migrations_already_applied = (await c.query(
      `SELECT filename FROM schema_migrations WHERE filename IN ('072_invoice_documents.sql','073_invoice_lifecycle.sql') ORDER BY filename`
    )).rows.map(r => r.filename);

    const dups = (await c.query(
      `SELECT lot_id, buyer_user_id, count(*)::int AS n FROM invoices
        WHERE lot_id IS NOT NULL AND buyer_user_id IS NOT NULL
        GROUP BY lot_id, buyer_user_id HAVING count(*) > 1`
    )).rows;
    out.duplicate_invoices = { count: dups.length, sample: dups.slice(0, 5) };

    out.invoices_total = (await c.query('SELECT count(*)::int n FROM invoices')).rows[0].n;
    const schema = (await c.query(`
      SELECT to_regclass('public.generated_documents') AS gen_docs,
             to_regclass('public.invoice_number_seq')  AS seq,
             to_regclass('public.idx_invoices_lot_buyer') AS uniq_idx,
             (SELECT count(*) FROM information_schema.columns WHERE table_name='invoices' AND column_name='invoice_number')::int AS has_invoice_number_col,
             (SELECT is_nullable FROM information_schema.columns WHERE table_name='invoices' AND column_name='payment_id') AS payment_id_nullable
    `)).rows[0];
    out.schema_state = schema;

    // Env classification (NEVER prints secret values — only var names + TEST/LIVE).
    const stripeVars = Object.entries(process.env)
      .filter(([, v]) => typeof v === 'string' && /^(sk|pk|rk)_(test|live)_/.test(v))
      .map(([k, v]) => ({ var: k, mode: v.includes('_live_') ? 'LIVE' : 'TEST' }));
    out.stripe = { keys: stripeVars, any_live: stripeVars.some(s => s.mode === 'LIVE') };
    out.ses_configured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    out.email_from_set = Boolean(process.env.EMAIL_FROM || process.env.SMTP_FROM);
    out.jwt_secret_set = Boolean(process.env.JWT_SECRET);

    // Gate evaluation
    const gates = {
      prod_endpoint: true,
      no_duplicate_invoices: out.duplicate_invoices.count === 0,
      stripe_is_test: stripeVars.length > 0 && !out.stripe.any_live && stripeVars.some(s => s.mode === 'TEST'),
      no_live_keys: !out.stripe.any_live,
      ses_configured: out.ses_configured,
      jwt_set: out.jwt_secret_set,
    };
    out.gates = gates;
    out.preflight_pass = Object.values(gates).every(Boolean);

    console.log('PREFLIGHT_JSON=' + JSON.stringify(out));
    console.log('PREFLIGHT: ' + (out.preflight_pass ? 'PASS' : 'FAIL'));
    return out.preflight_pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
