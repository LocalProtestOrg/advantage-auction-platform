#!/usr/bin/env node
/* prod-publish-buyer-terms-version.js: PRODUCTION-guarded. Publishes a buyer terms source document as a NEW buyer_terms
   version and makes it current. Dry run by default; --apply to write.
   Sources (body = everything below the first `---` line of the file):
     docs/legal/terms-of-service-v4.md        (default) "Advantage.Bid Terms of Service - General and Buyers"
     docs/legal/buyer-terms-v4-fixed-price.md "Advantage.Bid Buyer Terms & Conditions of Sale" (auctions + fixed-price)
   Options: --source <path>, --title "<title>" (default chosen from the source's heading), --apply.
   includes_sales_near_you (migration 158) is set to true when the source requires it: its header says
   `includes_sales_near_you = true`, or its body carries the Sales Near You clause (a version that discloses the benefit).
   Never edits or deletes an existing version or any acceptance: the previous current version only has is_current
   cleared (its text and every acceptance of it stay exactly as they were). One transaction; verified; audited.
   Buyers accept the new version at their next auction registration, storefront purchase, or account registration.
     railway run node scripts/prod-publish-buyer-terms-version.js                                                    # dry run
     railway run node scripts/prod-publish-buyer-terms-version.js --source docs/legal/buyer-terms-v4-fixed-price.md  # dry run
     railway run node scripts/prod-publish-buyer-terms-version.js --source docs/legal/buyer-terms-v4-fixed-price.md --apply */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const REPO = path.join(__dirname, '..');
const DEFAULT_SOURCE = path.join(REPO, 'docs', 'legal', 'terms-of-service-v4.md');
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

// The documents this script may publish, recognized by the body's first line. Anything else is refused.
const PROFILES = [
  { heading: '# Advantage.Bid Terms of Service', title: 'Advantage.Bid Terms of Service - General and Buyers', minLength: 10000 },
  { heading: '# Advantage.Bid Buyer Terms & Conditions of Sale', title: 'Advantage.Bid Buyer Terms & Conditions of Sale', minLength: 5000 },
];
const SALES_NEAR_YOU_CLAUSE = /\*\*Sales Near You\.\*\*/;

function parseArgs(argv) {
  const opts = { apply: argv.includes('--apply'), source: DEFAULT_SOURCE, title: null };
  const val = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(flag + ' needs a value');
    return v;
  };
  const src = val('--source'); if (src) opts.source = path.resolve(REPO, src);
  const title = val('--title'); if (title) opts.title = title;
  return opts;
}

// Split a source file into its header (above the first `---` line) and the body that is published.
function extractBody(md) {
  const text = String(md).replace(/\r\n/g, '\n');
  const i = text.indexOf('\n---\n');
  if (i === -1) throw new Error('separator not found');
  return { header: text.slice(0, i), body: text.slice(i + 5).trim() };
}

// Sanity checks before anything touches a database. Returns { ok, errors, profile, title, includesSalesNearYou }.
function validateSource({ header, body }, { title = null } = {}) {
  const errors = [];
  const profile = PROFILES.find((p) => body.startsWith(p.heading)) || null;
  if (!profile) errors.push('body must start with one of: ' + PROFILES.map((p) => p.heading).join(' | '));
  if (profile && body.length < profile.minLength) errors.push('body is too short (' + body.length + ' chars)');
  if (/[–—]/.test(body)) errors.push('body contains an en or em dash');
  if (/\[TO BE COMPLETED|must be removed before publication/i.test(body)) errors.push('body still contains a placeholder bracket');
  const headerRequiresSny = /includes_sales_near_you\s*=\s*true/.test(header || '');
  const bodyHasSny = SALES_NEAR_YOU_CLAUSE.test(body);
  if (headerRequiresSny && !bodyHasSny) errors.push('header requires includes_sales_near_you but the body has no Sales Near You clause');
  return {
    ok: errors.length === 0,
    errors,
    profile,
    title: title || (profile ? profile.title : null),
    includesSalesNearYou: headerRequiresSny || bodyHasSny,
  };
}

function loadSource(file) { return extractBody(fs.readFileSync(file, 'utf8')); }

async function main(argv) {
  const opts = parseArgs(argv);
  const APPLY = opts.apply;
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const src = loadSource(opts.source);
  const body = src.body;
  const v = validateSource(src, { title: opts.title });
  if (!v.ok) { console.error('FAIL: source text looks wrong: ' + v.errors.join('; ')); return 1; }
  const TITLE = v.title;
  const SNY = v.includesSalesNearYou;
  const sourceRel = path.relative(REPO, opts.source).split(path.sep).join('/');
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const hasSnyColumn = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'terms_versions' AND column_name = 'includes_sales_near_you'`)).rows.length === 1;
    if (SNY && !hasSnyColumn) { console.error('FAIL: this source requires includes_sales_near_you but terms_versions has no such column (migration 158).'); return 1; }
    const snap = async () => ({
      versions: (await c.query(`SELECT md5(string_agg(id::text || ':' || version_int || ':' || md5(body_markdown) || ':' || title, ',' ORDER BY version_int)) h FROM terms_versions WHERE kind = 'buyer_terms'`)).rows[0].h,
      acceptances: (await c.query(`SELECT md5(coalesce(string_agg(id::text || ':' || terms_version_id || ':' || accepted_at::text, ',' ORDER BY id), '')) h, count(*)::int n FROM terms_acceptances`)).rows[0],
    });
    const cur = (await c.query(`SELECT id, version_int, md5(body_markdown) h FROM terms_versions WHERE kind = 'buyer_terms' AND is_current`)).rows[0];
    if (cur && cur.h === md5(body)) { console.log('NO-OP: current version ' + cur.version_int + ' already has this exact text.'); return 0; }
    const next = Number((await c.query(`SELECT COALESCE(MAX(version_int),0)+1 n FROM terms_versions WHERE kind = 'buyer_terms'`)).rows[0].n);
    console.log((APPLY ? 'APPLY' : 'DRY RUN') + ': publish buyer_terms version ' + next + ' (current ' + (cur ? cur.version_int : 'none') + ') from ' + sourceRel
      + '; title "' + TITLE + '"; includes_sales_near_you ' + SNY + '; body md5 ' + md5(body) + ', ' + body.length + ' chars');
    if (!APPLY) return 0;
    const before = await snap();
    let newId;
    try {
      await c.query('BEGIN');
      await c.query(`LOCK TABLE terms_versions IN SHARE ROW EXCLUSIVE MODE`);
      await c.query(`UPDATE terms_versions SET is_current = false WHERE kind = 'buyer_terms' AND is_current`);
      newId = hasSnyColumn
        ? (await c.query(`INSERT INTO terms_versions (kind, version_int, title, body_markdown, effective_at, is_current, includes_sales_near_you)
            VALUES ('buyer_terms', $1, $2, $3, now(), true, $4) RETURNING id`, [next, TITLE, body, SNY])).rows[0].id
        : (await c.query(`INSERT INTO terms_versions (kind, version_int, title, body_markdown, effective_at, is_current)
            VALUES ('buyer_terms', $1, $2, $3, now(), true) RETURNING id`, [next, TITLE, body])).rows[0].id;
      await c.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, metadata) VALUES ('buyer_terms_version_published', 'terms_version', $1, $2)`,
        [newId, JSON.stringify({ version_int: next, previous_version_int: cur ? cur.version_int : null, body_md5: md5(body), source: sourceRel, title: TITLE, includes_sales_near_you: SNY, note: 'published before counsel review by owner direction' })]);
      const after = await snap();
      const check = {
        new_version_current: (await c.query(`SELECT is_current FROM terms_versions WHERE id = $1`, [newId])).rows[0].is_current === true,
        exactly_one_current: Number((await c.query(`SELECT count(*) n FROM terms_versions WHERE kind = 'buyer_terms' AND is_current`)).rows[0].n) === 1,
        new_text_matches_source: (await c.query(`SELECT md5(body_markdown) h FROM terms_versions WHERE id = $1`, [newId])).rows[0].h === md5(body),
        sales_near_you_flag_matches: !hasSnyColumn || (await c.query(`SELECT includes_sales_near_you f FROM terms_versions WHERE id = $1`, [newId])).rows[0].f === SNY,
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
}

module.exports = { parseArgs, extractBody, validateSource, loadSource, PROFILES, DEFAULT_SOURCE };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
}
