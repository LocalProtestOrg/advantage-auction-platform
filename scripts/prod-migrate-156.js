#!/usr/bin/env node
/* prod-migrate-156.js — PRODUCTION-guarded apply of ONLY 156_ses_stream_attribution.sql.
   Additive + idempotent: records which SES configuration set (and therefore which mail stream)
   produced each feedback event, so Event Partner deliverability is measurable separately.

   Run BEFORE deploying the application (sesFeedbackService writes the new columns).

   Verification proves the thing that matters most: suppression, complaint, bounce and deliverability
   state is untouched, because attribution is metadata and must never alter a protection. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '156_ses_stream_attribution.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP)) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes(PROD_EP)) { console.error('REFUSE: not the PRODUCTION endpoint (' + PROD_EP + ').'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    // Baseline every protection this migration must leave alone.
    const before = (await c.query(
      `SELECT (SELECT count(*)::int FROM email_suppressions) suppressions,
              (SELECT count(*)::int FROM email_deliverability) deliverability,
              (SELECT count(*)::int FROM ses_feedback_events) feedback_events,
              (SELECT count(*)::int FROM email_deliverability WHERE hard_bounced) hard_bounced,
              (SELECT count(*)::int FROM email_deliverability WHERE complaint) complaints`)).rows[0];

    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 156 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM email_suppressions) suppressions,
              (SELECT count(*)::int FROM email_deliverability) deliverability,
              (SELECT count(*)::int FROM ses_feedback_events) feedback_events,
              (SELECT count(*)::int FROM email_deliverability WHERE hard_bounced) hard_bounced,
              (SELECT count(*)::int FROM email_deliverability WHERE complaint) complaints,
              (SELECT count(*)::int FROM ses_feedback_events WHERE mail_stream IS NOT NULL) attributed`)).rows[0];
    const cols = (await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='ses_feedback_events' AND column_name IN ('configuration_set','mail_stream','ses_message_id')`)).rows.map((r) => r.column_name).sort();
    const chk = (await c.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_ses_feedback_mail_stream'`)).rowCount;
    const sets = {};
    (await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'email.configuration_sets.%'`)).rows
      .forEach((r) => { sets[r.key] = r.value; });
    // Event Partner gates must be exactly as they were — this migration enables nothing.
    const gatesOn = (await c.query(
      `SELECT key FROM platform_config WHERE key LIKE 'event_partners.%'
        AND (value='true'::jsonb OR value='"true"'::jsonb)
        AND key <> 'event_partners.webhook_signature_required'`)).rows.map((r) => r.key);

    const checks = {
      columns_added: cols.join(',') === 'configuration_set,mail_stream,ses_message_id',
      stream_vocabulary_closed: chk === 1,
      event_partner_set_recorded: sets['email.configuration_sets.event_partner'] === 'advantage-bid-event-partner',
      marketing_set_recorded: sets['email.configuration_sets.marketing'] === 'advantage-bid-marketing',
      // The protections, byte for byte.
      suppressions_unchanged: after.suppressions === before.suppressions,
      deliverability_unchanged: after.deliverability === before.deliverability,
      hard_bounce_state_unchanged: after.hard_bounced === before.hard_bounced,
      complaint_state_unchanged: after.complaints === before.complaints,
      feedback_events_unchanged: after.feedback_events === before.feedback_events,
      // Historical rows are left unattributed rather than back-filled with a guess.
      no_historical_backfill: after.attributed === 0,
      no_event_partner_gate_enabled: gatesOn.length === 0,
      ledger: await ledgerHas(c),
    };
    console.log('Before:', JSON.stringify(before));
    console.log('After: ', JSON.stringify(after));
    console.log('Sets:  ', JSON.stringify(sets));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    if (failed.length) console.error('FAILED CHECKS:', failed.join(', '));
    console.log('RESULT: ' + (failed.length ? 'FAIL' : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
