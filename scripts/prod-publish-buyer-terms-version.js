#!/usr/bin/env node
/* prod-publish-buyer-terms-version.js: PRODUCTION-guarded. Publishes docs/legal/terms-of-service-v4.md (the full
   "Advantage.Bid Terms of Service - General and Buyers") as a NEW buyer_terms version and makes it current, so every
   buyer accepts the full terms (owner direction 2026-11-06). Dry run by default; --apply to write.
   Never edits or deletes an existing version or any acceptance: the previous current version only has is_current
   cleared (its text and every acceptance of it stay exactly as they were). One transaction; verified; audited.
   Buyers accept the new version at their next auction registration, storefront purchase, or account registration.
     railway run node scripts/prod-publish-buyer-terms-version.js            # dry run
     railway run node scripts/prod-publish-buyer-terms-version.js --apply    # publish */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const SOURCE = path.join(__dirname, '..', 'docs', 'legal', 'terms-of-service-v4.md');
const TITLE = 'Advantage.Bid Terms of Service - General and Buyers';
const APPLY = process.argv.includes('--apply');
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

function extractBody() {
  const md = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  const i = md.indexOf('\n---\n');
  if (i === -1) throw new Error('separator not found');
  return md.slice(i + 5).trim();
}

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const body = extractBody();
  if (body.length < 10000 || !body.startsWith('# Advantage.Bid Terms of Service') || /[–—]/.test(body)) { console.error('FAIL: source text looks wrong'); return 1; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const snap = async () => ({
      versions: (await c.query(`SELECT md5(string_agg(id::text || ':' || version_int || ':' || md5(body_markdown) || ':' || title, ',' ORDER BY version_int)) h FROM terms_versions WHERE kind = 'buyer_terms'`)).rows[0].h,
      acceptances: (await c.query(`SELECT md5(coalesce(string_agg(id::text || ':' || terms_version_id || ':' || accepted_at::text, ',' ORDER BY id), '')) h, count(*)::int n FROM terms_acceptances`)).rows[0],
    });
    const cur = (await c.query(`SELECT id, version_int, md5(body_markdown) h FROM terms_versions WHERE kind = 'buyer_terms' AND is_current`)).rows[0];
    if (cur && cur.h === md5(body)) { console.log('NO-OP: current version ' + cur.version_int + ' already has this exact text.'); return 0; }
    const next = Number((await c.query(`SELECT COALESCE(MAX(version_int),0)+1 n FROM terms_versions WHERE kind = 'buyer_terms'`)).rows[0].n);
    console.log((APPLY ? 'APPLY' : 'DRY RUN') + ': publish buyer_terms version ' + next + ' (current ' + (cur ? cur.version_int : 'none') + '); body md5 ' + md5(body) + ', ' + body.length + ' chars');
    if (!APPLY) return 0;
    const before = await snap();
    let newId;
    try {
      await c.query('BEGIN');
      await c.query(`LOCK TABLE terms_versions IN SHARE ROW EXCLUSIVE MODE`);
      await c.query(`UPDATE terms_versions SET is_current = false WHERE kind = 'buyer_terms' AND is_current`);
      newId = (await c.query(`INSERT INTO terms_versions (kind, version_int, title, body_markdown, effective_at, is_current)
        VALUES ('buyer_terms', $1, $2, $3, now(), true) RETURNING id`, [next, TITLE, body])).rows[0].id;
      await c.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, metadata) VALUES ('buyer_terms_version_published', 'terms_version', $1, $2)`,
        [newId, JSON.stringify({ version_int: next, previous_version_int: cur ? cur.version_int : null, body_md5: md5(body), source: 'docs/legal/terms-of-service-v4.md', note: 'published before counsel review by owner direction 2026-11-06' })]);
      const after = await snap();
      const check = {
        new_version_current: (await c.query(`SELECT is_current FROM terms_versions WHERE id = $1`, [newId])).rows[0].is_current === true,
        exactly_one_current: Number((await c.query(`SELECT count(*) n FROM terms_versions WHERE kind = 'buyer_terms' AND is_current`)).rows[0].n) === 1,
        new_text_matches_source: (await c.query(`SELECT md5(body_markdown) h FROM terms_versions WHERE id = $1`, [newId])).rows[0].h === md5(body),
        previous_versions_unchanged: (await c.query(`SELECT md5(string_agg(id::text || ':' || version_int || ':' || md5(body_markdown) || ':' || title, ',' ORDER BY version_int)) h FROM terms_versions WHERE kind = 'buyer_terms' AND id <> $1`, [newId])).rows[0].h === before.versions,
        acceptances_unchanged: after.acceptances.h === before.acceptances.h && after.acceptances.n === before.acceptances.n,
      };
      const failed = Object.keys(check).filter((k) => !check[k]);
      if (failed.length) { await c.query('ROLLBACK'); console.log('VERIFY FAILED (rolled back):', failed.join(', ')); return 1; }
      await c.query('COMMIT');
      console.log('Verify:', JSON.stringify(check, null, 2));
      console.log('RESULT: PASS');
      return 0;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED (rolled back):', e.message); return 1; }
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
