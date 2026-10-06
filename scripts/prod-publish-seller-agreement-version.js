#!/usr/bin/env node
/* prod-publish-seller-agreement-version.js — PRODUCTION-guarded. Publishes the Seller Agreement text in
   docs/seller-agreement-v1-content.md as a NEW immutable template version of the existing Seller Agreement template,
   and points the template at it for FUTURE agreements. Dry run by default; --apply to write.

   Never modifies an existing version row, an issued or signed agreement, a signature, or a seller. Existing agreements
   keep the version they pinned (their frozen rendered_body and signature content hash). The variable schema and
   defaults are copied from the current version (only the body text changes). One transaction; audited.

     railway run node scripts/prod-publish-seller-agreement-version.js            # dry run
     railway run node scripts/prod-publish-seller-agreement-version.js --apply    # publish */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const TEMPLATE = 'ab000000-0000-4000-8000-000000000001';
const APPLY = process.argv.includes('--apply');
const REASON = (process.argv.find((a) => a.startsWith('--reason=')) || '').slice('--reason='.length) || 'Seller Agreement text update';
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

function extractBody() {   // identical extraction to prod-seed-agreement-template.js
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'seller-agreement-v1-content.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = md.indexOf('## Agreement body');
  if (start === -1) throw new Error('Agreement body marker not found');
  let body = md.slice(md.indexOf('\n', start) + 1);
  const end = body.indexOf('### Authoring notes');
  if (end !== -1) body = body.slice(0, end);
  return body.replace(/\n+---\s*$/, '').trim();
}

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  process.env.DATABASE_URL = raw.replace('-pooler', '');
  const body = extractBody();
  if (body.length < 500 || !/Advantage\.Bid Seller Consignment/.test(body)) { console.error('FAIL: extracted body looks wrong'); return 1; }
  const db = require('../src/db');
  const c = await db.connect();
  try {
    const snap = async () => ({
      versions: (await c.query(`SELECT md5(string_agg(id::text || ':' || version_int || ':' || md5(body_markdown), ',' ORDER BY version_int)) h FROM agreement_template_versions WHERE template_id = $1`, [TEMPLATE])).rows[0].h,
      agreements: (await c.query(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || template_version_id || ':' || md5(coalesce(rendered_body,'')), ',' ORDER BY id), '')) h, count(*)::int n FROM agreements`)).rows[0],
      signatures: (await c.query(`SELECT md5(coalesce(string_agg(id::text || ':' || content_sha256, ',' ORDER BY id), '')) h FROM agreement_signatures`)).rows[0].h,
      sellers: (await c.query(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(platform_fee_bps::text,'-') || ':' || coalesce(agreement_waived_at::text,'-'), ',' ORDER BY id), '')) h FROM seller_profiles`)).rows[0].h,
      config: (await c.query(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config`)).rows[0].h,
    });
    const tpl = (await c.query(`SELECT t.id, t.is_active, t.current_version_id, v.version_int, v.body_markdown, v.variable_schema, v.effective_terms_defaults
      FROM agreement_templates t JOIN agreement_template_versions v ON v.id = t.current_version_id WHERE t.id = $1`, [TEMPLATE])).rows[0];
    if (!tpl) { console.error('REFUSE: Seller Agreement template or current version not found.'); return 1; }
    if (tpl.body_markdown.replace(/\r\n/g, '\n').trim() === body) { console.log('NO-OP: current version ' + tpl.version_int + ' already has this exact text.'); return 0; }
    const next = Number((await c.query(`SELECT COALESCE(MAX(version_int),0)+1 AS n FROM agreement_template_versions WHERE template_id = $1`, [TEMPLATE])).rows[0].n);
    console.log((APPLY ? 'APPLY' : 'DRY RUN') + ': publish Seller Agreement version ' + next + ' (current ' + tpl.version_int + '); new body md5 ' + md5(body));
    if (!APPLY) return 0;
    const before = await snap();
    let newId;
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM agreement_templates WHERE id = $1 FOR UPDATE', [TEMPLATE]);
      newId = (await c.query(
        `INSERT INTO agreement_template_versions (template_id, version_int, body_markdown, variable_schema, effective_terms_defaults)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id`,
        [TEMPLATE, next, body, JSON.stringify(tpl.variable_schema), JSON.stringify(tpl.effective_terms_defaults)])).rows[0].id;
      await c.query(`UPDATE agreement_templates SET current_version_id = $1, updated_at = now() WHERE id = $2`, [newId, TEMPLATE]);
      await c.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, metadata) VALUES ('agreement_template_version_published', 'agreement_template', $1, $2::jsonb)`,
        [TEMPLATE, JSON.stringify({ version_int: next, version_id: newId, previous_version_int: tpl.version_int, via: 'prod-publish-seller-agreement-version',
          reason: REASON })]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    const after = await snap();
    const cur = (await c.query(`SELECT t.current_version_id, v.version_int, v.body_markdown FROM agreement_templates t JOIN agreement_template_versions v ON v.id = t.current_version_id WHERE t.id = $1`, [TEMPLATE])).rows[0];
    const prev = (await c.query(`SELECT md5(body_markdown) h FROM agreement_template_versions WHERE id = $1`, [tpl.current_version_id])).rows[0];
    const checks = {
      new_version_current: cur.current_version_id === newId && cur.version_int === next,
      new_version_text_matches_source: cur.body_markdown === body,
      previous_version_text_unchanged: prev.h === md5(tpl.body_markdown),
      issued_and_signed_agreements_unchanged: before.agreements.h === after.agreements.h && before.agreements.n === after.agreements.n,
      signatures_unchanged: before.signatures === after.signatures,
      seller_fees_and_waivers_unchanged: before.sellers === after.sellers,
      platform_config_unchanged: before.config === after.config,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
