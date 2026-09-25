#!/usr/bin/env node
/* prod-migrate-171.js — PRODUCTION-guarded apply of ONLY 171_claimed_listing_pilot_readiness.sql.
   Verifies: the new decision / member status / task type are accepted and every old value still is; the
   two config keys exist; the four programme switches, the postal address and the pause reason are
   byte-for-byte unchanged (still OFF); no cohort, template, sequence, message, suppression or decision row
   was added or removed. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '171_claimed_listing_pilot_readiness.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const SWITCHES = ['claimed_listings.sending_enabled', 'claimed_listings.inbound_enabled', 'claimed_listings.activation_emails_enabled',
  'claimed_listings.self_request_enabled', 'claimed_listings.paused_reason', 'company.postal_address'];

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
        `SELECT (SELECT count(*)::int FROM listing_outreach_cohorts) cohorts, (SELECT count(*)::int FROM listing_outreach_cohort_members) members,
                (SELECT count(*)::int FROM listing_outreach_templates) templates, (SELECT count(*)::int FROM listing_outreach_sequences) sequences,
                (SELECT count(*)::int FROM listing_outreach_messages) messages, (SELECT count(*)::int FROM listing_outreach_suppressions) suppressions,
                (SELECT count(*)::int FROM listing_outreach_eligibility_decisions) decisions, (SELECT count(*)::int FROM listing_tasks) tasks`)).rows[0],
    });
    const before = await snap();
    const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
    if (done) console.log('SKIP apply (already recorded). Verifying only.');
    else {
      try { await c.query(fs.readFileSync(FILE_PATH, 'utf8')); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 171.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const def = async (name) => ((await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = $1`, [name])).rows[0] || {}).d || '';
    const decision = await def('chk_lode_decision');
    const member = await def('listing_outreach_cohort_members_status_check');
    const task = await def('listing_tasks_task_type_check');
    const cfg = (await c.query(`SELECT key, value FROM platform_config WHERE key IN ('claimed_listings.claim_plan_ids','claimed_listings.max_send_attempts')`)).rows
      .reduce((m, r) => { m[r.key] = r.value; return m; }, {});
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      decision_paid_member: decision.includes('EXCLUDE_PAID_MEMBER') && decision.includes('ELIGIBLE_UNCLAIMED_LISTING') && decision.includes('REVIEW_DATA_QUALITY'),
      member_excluded_status: member.includes('excluded') && member.includes('pending') && member.includes('stopped'),
      task_delivery_issue: task.includes('delivery_issue') && task.includes('reply_received') && task.includes('legal_escalation'),
      excluded_columns: (await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'listing_outreach_cohort_members' AND column_name IN ('excluded_by','excluded_at')`)).rows[0].n === 2,
      claim_plan_ids: JSON.stringify(cfg['claimed_listings.claim_plan_ids']) === '["7"]',
      max_send_attempts: Number(cfg['claimed_listings.max_send_attempts']) === 5,
      switches_unchanged: JSON.stringify(before.switches) === JSON.stringify(after.switches),
      sending_still_off: after.switches.filter((s) => /_enabled$/.test(s.key)).every((s) => s.v === 'false'),
      no_rows_added_or_removed: JSON.stringify(before.counts) === JSON.stringify(after.counts),
    };
    console.log('Switches:', JSON.stringify(after.switches.map((s) => s.key + '=' + (s.key === 'company.postal_address' ? (s.v === '""' ? '(empty)' : '(set)') : s.v))));
    console.log('Counts before:', JSON.stringify(before.counts), 'after:', JSON.stringify(after.counts));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
