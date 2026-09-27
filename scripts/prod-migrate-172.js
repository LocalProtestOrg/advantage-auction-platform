#!/usr/bin/env node
/* prod-migrate-172.js — PRODUCTION-guarded apply of ONLY 172_ses_inbound_email.sql (shared SES inbound receipts).
   Verifies: the table and its unique SES-message-id index exist and it is empty; the inbound, sending and
   activation switches for Claimed Listing and Event Partner are byte-for-byte unchanged; no Claimed Listing
   or Event Partner message, suppression or cohort row was added or removed. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '172_ses_inbound_email.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const SWITCHES = ['claimed_listings.sending_enabled', 'claimed_listings.inbound_enabled', 'claimed_listings.activation_emails_enabled',
  'claimed_listings.self_request_enabled', 'event_partners.inbound_enabled', 'company.postal_address'];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => ({
      switches: (await c.query(`SELECT key, value::text AS v FROM platform_config WHERE key = ANY($1) ORDER BY key`, [SWITCHES])).rows,
      counts: (await c.query(
        `SELECT (SELECT count(*)::int FROM listing_outreach_messages) listing_messages, (SELECT count(*)::int FROM listing_outreach_suppressions) listing_suppressions,
                (SELECT count(*)::int FROM listing_outreach_cohorts) cohorts, (SELECT count(*)::int FROM event_partner_messages) ep_messages,
                (SELECT count(*)::int FROM event_partner_suppressions) ep_suppressions, (SELECT count(*)::int FROM email_suppressions) global_suppressions`)).rows[0],
    });
    const before = await snap();
    const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
    if (done) console.log('SKIP apply (already recorded). Verifying only.');
    else {
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(FILE_PATH, 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 172.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      table_exists: !!(await c.query(`SELECT to_regclass('public.inbound_email_receipts') t`)).rows[0].t,
      unique_ses_message_id: (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_inbound_email_receipts_ses_message'`)).rowCount === 1,
      table_empty: (await c.query(`SELECT count(*)::int n FROM inbound_email_receipts`)).rows[0].n === 0,
      switches_unchanged: JSON.stringify(before.switches) === JSON.stringify(after.switches),
      inbound_still_off: after.switches.filter((s) => /inbound_enabled$/.test(s.key)).every((s) => s.v === 'false'),
      no_rows_added_or_removed: JSON.stringify(before.counts) === JSON.stringify(after.counts),
    };
    console.log('Switches:', JSON.stringify(after.switches.map((s) => s.key + '=' + (s.key === 'company.postal_address' ? '(set)' : s.v))));
    console.log('Counts before:', JSON.stringify(before.counts), 'after:', JSON.stringify(after.counts));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
