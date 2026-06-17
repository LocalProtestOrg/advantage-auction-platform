#!/usr/bin/env node
/*
 * stg-seed-agreement-template.js — STAGING-guarded. Seeds the Seller Agreement v1
 * template (agreement_type='private') + immutable version 1 from the approved
 * content in docs/seller-agreement-v1-content.md. Idempotent (fixed UUIDs).
 *
 *   railway run --service advantage-staging --environment production node scripts/stg-seed-agreement-template.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const TEMPLATE = 'ab000000-0000-4000-8000-000000000001';
const VERSION  = 'ab000000-0000-4000-8000-000000000002';

const VARIABLE_SCHEMA = [
  { key: 'legal_name', type: 'string', source: 'identity', required: true },
  { key: 'company_name', type: 'string', source: 'identity' },
  { key: 'signatory_name', type: 'string', source: 'identity', required: true },
  { key: 'signatory_title', type: 'string', source: 'identity' },
  { key: 'seller_address', type: 'string', source: 'manual', required: true },
  { key: 'seller_phone', type: 'string', source: 'manual' },
  { key: 'seller_type', type: 'string', source: 'manual', required: true },
  { key: 'commission_pct', type: 'percent', source: 'terms', required: true },
  { key: 'buyer_premium_pct', type: 'percent', source: 'terms' },
  { key: 'credit_card_fee_pct', type: 'percent', source: 'terms' },
  { key: 'marketing_fee_cents', type: 'currency_cents', source: 'terms' },
  { key: 'settlement_terms', type: 'string', source: 'terms', required: true },
  { key: 'payout_schedule', type: 'string', source: 'terms', required: true },
  { key: 'effective_date', type: 'date', source: 'manual', required: true },
  { key: 'governing_state', type: 'string', source: 'manual', required: true },
];

function extractBody() {
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'seller-agreement-v1-content.md'), 'utf8');
  const start = md.indexOf('## Agreement body');
  if (start === -1) throw new Error('Agreement body marker not found');
  let body = md.slice(md.indexOf('\n', start) + 1);
  const end = body.indexOf('### Authoring notes');
  if (end !== -1) body = body.slice(0, end);
  // drop a trailing horizontal rule before the authoring notes section
  return body.replace(/\n+---\s*$/, '').trim();
}

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: PRODUCTION endpoint. STAGING-only.'); return 2; }
  if (!raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: not the STAGING endpoint.'); return 2; }
  const body = extractBody();
  if (body.length < 500 || !/Advantage\.Bid Seller Consignment/.test(body)) { console.error('FAIL: extracted body looks wrong (' + body.length + ' chars)'); return 1; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO agreement_templates (id, agreement_type, name, description, is_active)
       VALUES ($1,'private','Seller Agreement v1 (private)','Advantage.Bid seller consignment and auction services agreement',true)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, is_active=true, updated_at=now()`, [TEMPLATE]);
    await c.query(
      `INSERT INTO agreement_template_versions (id, template_id, version_int, body_markdown, variable_schema, effective_terms_defaults)
       VALUES ($1,$2,1,$3,$4::jsonb,'{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET body_markdown=EXCLUDED.body_markdown, variable_schema=EXCLUDED.variable_schema`,
      [VERSION, TEMPLATE, body, JSON.stringify(VARIABLE_SCHEMA)]);
    await c.query(`UPDATE agreement_templates SET current_version_id=$1, updated_at=now() WHERE id=$2`, [VERSION, TEMPLATE]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('FAIL', e.message); c.release(); await pool.end(); return 1; }

  const t = (await c.query(`SELECT t.agreement_type, t.is_active, t.current_version_id, v.version_int, length(v.body_markdown) blen
     FROM agreement_templates t JOIN agreement_template_versions v ON v.id=t.current_version_id WHERE t.id=$1`, [TEMPLATE])).rows[0];
  console.log('Template: type=' + t.agreement_type + ' active=' + t.is_active + ' current_version=' + t.version_int + ' body_len=' + t.blen);
  const pass = t && t.agreement_type === 'private' && t.is_active && t.version_int === 1 && t.blen > 500;
  console.log('RESULT: ' + (pass ? 'PASS (Seller Agreement v1 template active with current version)' : 'FAIL'));
  c.release(); await pool.end();
  return pass ? 0 : 1;
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
