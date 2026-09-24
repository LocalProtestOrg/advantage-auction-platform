#!/usr/bin/env node
/* prod-migrate-168.js — PRODUCTION-guarded apply of ONLY 168_member_neutral_import.sql.
   Verifies: the dedicated member source is disabled + RETIRED (row kept, run history kept); the federal
   source declares placeholder_images; no event / provenance / source row was deleted; the member's
   organization, members, events, agreements and pricing rows are byte-for-byte unchanged (row hashes);
   the member's imported events are unchanged. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '168_member_neutral_import.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const SOURCE_KEY = 'lmauction-lewis-maese';
const MEMBER_ORG = '77c403f5-0c8c-4a5e-824a-cf113beb5217';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  const hash = async (sql, params) => (await c.query(`SELECT count(*)::int n, md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) h FROM (${sql}) t`, params)).rows[0];
  try {
    const snap = async () => ({
      counts: (await c.query(
        `SELECT (SELECT count(*)::int FROM events) events,
                (SELECT count(*)::int FROM event_sources) provenance,
                (SELECT count(*)::int FROM import_sources) sources,
                (SELECT count(*)::int FROM import_runs) runs`)).rows[0],
      org: await hash(`SELECT * FROM organizations WHERE id = $1`, [MEMBER_ORG]),
      members: await hash(`SELECT * FROM organization_members WHERE organization_id = $1`, [MEMBER_ORG]),
      org_events: await hash(`SELECT * FROM events WHERE organization_id = $1 OR host_organization_id = $1`, [MEMBER_ORG]),
      imported_events: await hash(`SELECT e.* FROM events e JOIN event_sources es ON es.event_id = e.id JOIN import_sources s ON s.id = es.source_id WHERE s.key = $1`, [SOURCE_KEY]),
      pricing: await hash(`SELECT * FROM professional_pricing_agreements`, []),
      seller_profiles: await hash(`SELECT * FROM seller_profiles`, []),
    });
    const before = await snap();
    const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
    if (done) console.log('SKIP apply (already recorded). Verifying only.');
    else {
      try { await c.query(fs.readFileSync(FILE_PATH, 'utf8')); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 168.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const src = (await c.query(`SELECT status, health_state, next_retry_at, config ? 'retired_reason' AS retired FROM import_sources WHERE key = $1`, [SOURCE_KEY])).rows[0];
    const gsa = (await c.query(`SELECT (config->>'placeholder_images')::boolean p FROM import_sources WHERE key = 'gsa-auctions'`)).rows[0];
    const pub = (await c.query(`SELECT e.status, e.organizer_name FROM events e JOIN event_sources es ON es.event_id = e.id JOIN import_sources s ON s.id = es.source_id
        WHERE s.key = $1 AND e.end_at >= now()`, [SOURCE_KEY])).rows;
    const same = (k) => before[k].n === after[k].n && before[k].h === after[k].h;
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      member_source_retired: !!src && src.status === 'disabled' && src.health_state === 'RETIRED' && src.retired && src.next_retry_at === null,
      federal_placeholder_policy: !!gsa && gsa.p === true,
      no_event_deleted: after.counts.events === before.counts.events,
      no_provenance_deleted: after.counts.provenance === before.counts.provenance,
      no_source_deleted: after.counts.sources === before.counts.sources,
      run_history_kept: after.counts.runs === before.counts.runs,
      member_org_unchanged: same('org') && after.org.n === 1,
      member_accounts_unchanged: same('members'),
      member_events_unchanged: same('org_events'),
      member_imported_history_unchanged: same('imported_events'),
      pricing_agreements_unchanged: same('pricing'),
      seller_profiles_unchanged: same('seller_profiles'),
      upcoming_member_event_still_published: pub.every((r) => r.status === 'published'),
    };
    console.log('Before:', JSON.stringify(before));
    console.log('After: ', JSON.stringify(after));
    console.log('Source:', JSON.stringify(src), 'Upcoming imported member events:', JSON.stringify(pub));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
