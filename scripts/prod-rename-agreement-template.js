#!/usr/bin/env node
/* prod-rename-agreement-template.js — PRODUCTION-guarded. Changes ONLY agreement_templates.name (a display label read
   live by staff/seller agreement lists and the signing-page header) for the Seller Agreement template. It is not part
   of any rendered agreement body, signature, content hash or signed PDF, so historical evidence is unaffected.
   Dry run by default; --apply to write. Audited; verifies versions, agreements and signatures are unchanged.

     railway run node scripts/prod-rename-agreement-template.js --name="Seller Agreement" [--apply] */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const TEMPLATE = 'ab000000-0000-4000-8000-000000000001';
const APPLY = process.argv.includes('--apply');
const NAME = ((process.argv.find((a) => a.startsWith('--name=')) || '').slice('--name='.length) || '').trim();

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  if (!NAME || NAME.length > 120) { console.error('REFUSE: --name="..." (1-120 chars) is required.'); return 2; }
  process.env.DATABASE_URL = raw.replace('-pooler', '');
  const db = require('../src/db');
  const c = await db.connect();
  try {
    const h = async (sql) => (await c.query(sql)).rows[0].h;
    const snap = async () => ({
      versions: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || version_int || ':' || md5(body_markdown), ',' ORDER BY id), '')) h FROM agreement_template_versions`),
      agreements: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || template_version_id || ':' || md5(coalesce(rendered_body,'')) || ':' || coalesce(signed_pdf_sha256,'-'), ',' ORDER BY id), '')) h FROM agreements`),
      signatures: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || content_sha256, ',' ORDER BY id), '')) h FROM agreement_signatures`),
      template_other: await h(`SELECT md5(id::text || agreement_type || is_active::text || coalesce(current_version_id::text,'-')) h FROM agreement_templates WHERE id = '${TEMPLATE}'`),
    });
    const t = (await c.query(`SELECT name FROM agreement_templates WHERE id = $1`, [TEMPLATE])).rows[0];
    if (!t) { console.error('REFUSE: template not found.'); return 1; }
    if (t.name === NAME) { console.log('NO-OP: name is already "' + NAME + '".'); return 0; }
    console.log((APPLY ? 'APPLY' : 'DRY RUN') + ': rename "' + t.name + '" -> "' + NAME + '"');
    if (!APPLY) return 0;
    const before = await snap();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE agreement_templates SET name = $2, updated_at = now() WHERE id = $1`, [TEMPLATE, NAME]);
      await c.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, metadata) VALUES ('agreement_template_renamed', 'agreement_template', $1, $2::jsonb)`,
        [TEMPLATE, JSON.stringify({ before: t.name, after: NAME, via: 'prod-rename-agreement-template', note: 'display name only' })]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    const after = await snap();
    const checks = {
      renamed: (await c.query(`SELECT name FROM agreement_templates WHERE id = $1`, [TEMPLATE])).rows[0].name === NAME,
      versions_unchanged: before.versions === after.versions,
      agreements_unchanged: before.agreements === after.agreements,
      signatures_unchanged: before.signatures === after.signatures,
      template_id_type_active_current_unchanged: before.template_other === after.template_other,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
