#!/usr/bin/env node
/* prod-migrate-158.js — PRODUCTION-guarded apply of ONLY 158_buyer_lifecycle_sales_near_you.sql.

   Additive + idempotent: marks which buyer terms versions DISCLOSE Sales Near You, publishes buyer
   terms v3 (v1 verbatim plus one new numbered term), and creates the registration-enrolment evidence
   table. No contact is created, no acceptance is rewritten, no email is sent.

   Run BEFORE deploying the code that depends on it.

   The verification below is written against the Owner's constraints rather than against the SQL:
   the new term must read as a benefit and not a warning, it must carry NO unsubscribe sentence, no
   historical acceptance may be fabricated or rewritten, no existing buyer may be enrolled by the
   migration itself, and nothing about sending may switch on. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '158_buyer_lifecycle_sales_near_you.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const PAID_OFF = ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled',
  'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled'];
// The exact term the Owner approved, normalized for whitespace before comparison.
const TERM = 'Sales Near You. Registration includes email notifications about qualifying upcoming '
  + 'auctions and estate sales near you, generally within 30 miles of your location.';
// Language that must NOT appear in a registration term: the Owner asked for no unsubscribe sentence
// here (it belongs in the emails, where the legal requirement actually applies) and for nothing that
// reads as a warning.
const FORBIDDEN = [/unsubscribe/i, /opt[\s-]?out/i, /withdraw your consent/i, /you may stop/i,
  /warning/i, /by checking/i, /consent to receive marketing/i];
const norm = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
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
    const before = (await c.query(
      `SELECT (SELECT count(*)::int FROM marketing_contacts) contacts,
              (SELECT count(*)::int FROM terms_acceptances) acceptances,
              (SELECT count(*)::int FROM email_suppressions) suppressions,
              (SELECT count(*)::int FROM users) users,
              (SELECT count(*)::int FROM auction_registrations) auction_registrations`)).rows[0];

    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 158 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM marketing_contacts) contacts,
              (SELECT count(*)::int FROM terms_acceptances) acceptances,
              (SELECT count(*)::int FROM email_suppressions) suppressions,
              (SELECT count(*)::int FROM users) users,
              (SELECT count(*)::int FROM auction_registrations) auction_registrations,
              (SELECT count(*)::int FROM buyer_sales_near_you_enrollments) enrollments`)).rows[0];

    const versions = (await c.query(
      `SELECT version_int, is_current, includes_sales_near_you, body_markdown
         FROM terms_versions WHERE kind='buyer_terms' ORDER BY version_int`)).rows;
    const v3 = versions.find((v) => v.version_int === 3) || null;
    const body = norm(v3 && v3.body_markdown);
    const hasCol = (await c.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='terms_versions' AND column_name='includes_sales_near_you'`)).rowCount;
    const idx = (await c.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='buyer_sales_near_you_enrollments' ORDER BY 1`)).rows.map((r) => r.indexname);
    const trg = (await c.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='buyer_sales_near_you_enrollments'::regclass AND contype='c'`)).rowCount;
    const cfg = {};
    (await c.query(
      `SELECT key, value FROM platform_config
        WHERE key IN ('marketing.sales_near_you.enroll_on_registration','marketing.email.sales_near_you_enabled')`
    )).rows.forEach((r) => { cfg[r.key] = r.value; });
    const paidOn = (await c.query(
      `SELECT key FROM platform_config WHERE key = ANY($1) AND (value='true'::jsonb OR value='"true"'::jsonb)`, [PAID_OFF])).rows.map((r) => r.key);
    // v1 is the version that was actually in force; v3 must contain it verbatim, not replace it.
    const v1 = versions.find((v) => v.version_int === 1) || null;
    const v1Terms = norm(v1 && v1.body_markdown).match(/\d+\.\s+[A-Z][^.]*\./g) || [];
    const v1Preserved = v1Terms.length > 0 && v1Terms.every((t) => body.includes(t));

    const checks = {
      // Structure
      disclosure_column_exists: hasCol === 1,
      v3_exists: !!v3,
      v3_is_current: !!(v3 && v3.is_current === true),
      exactly_one_current_buyer_terms: versions.filter((v) => v.is_current).length === 1,
      v3_marked_disclosing: !!(v3 && v3.includes_sales_near_you === true),
      // The Owner's words, and only the Owner's words.
      term_text_exact: body.includes(TERM),
      no_unsubscribe_or_warning_language: FORBIDDEN.every((re) => !re.test(body.slice(body.indexOf('Sales Near You')))),
      v1_terms_preserved_verbatim: v1Preserved,
      // Consent honesty: every OLDER version stays non-disclosing, so no historical acceptance is
      // reinterpreted as consent to something it never mentioned.
      historical_versions_non_disclosing: versions.filter((v) => v.version_int !== 3).every((v) => v.includes_sales_near_you === false),
      no_acceptance_fabricated: after.acceptances === before.acceptances,
      // The migration enrols nobody. Enrolment only ever happens at a real registration event.
      enrollment_table_empty: after.enrollments === 0,
      enrollment_idempotency_index: idx.includes('uq_bsny_enrollment'),
      enrollment_trigger_constrained: trg >= 1,
      // Collection is on; SENDING is untouched and still off.
      enroll_on_registration_on: cfg['marketing.sales_near_you.enroll_on_registration'] === true,
      sending_still_off: cfg['marketing.email.sales_near_you_enabled'] === false,
      // Nothing else moved.
      no_contacts_created: after.contacts === before.contacts,
      suppressions_unchanged: after.suppressions === before.suppressions,
      users_unchanged: after.users === before.users,
      auction_registrations_unchanged: after.auction_registrations === before.auction_registrations,
      paid_gates_unchanged: paidOn.length === 0,
      ledger: await ledgerHas(c),
    };
    console.log('Before:', JSON.stringify(before));
    console.log('After: ', JSON.stringify(after));
    console.log('Buyer terms:', JSON.stringify(versions.map((v) => ({ v: v.version_int, current: v.is_current, discloses: v.includes_sales_near_you }))));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    if (failed.length) console.error('FAILED CHECKS:', failed.join(', '));
    console.log('RESULT: ' + (failed.length ? 'FAIL' : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
