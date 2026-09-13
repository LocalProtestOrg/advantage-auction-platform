#!/usr/bin/env node
/* prod-migrate-157.js — PRODUCTION-guarded apply of ONLY 157_sales_near_you_entitlements.sql.
   Additive + idempotent: the Sales Near You event-entitlement layer (EVERYONE MAY SUBSCRIBE; NOT EVERY
   EVENT MAY SEND), the event-aware obligation column, and the Owner's 30-mile email radius.

   Run BEFORE deploying the code that depends on it.

   Verification proves the policy is actually in force and that nothing about subscribers, suppression
   or paid marketing moved. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '157_sales_near_you_entitlements.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const PAID_OFF = ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled',
  'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled'];
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
              (SELECT count(*)::int FROM email_suppressions) suppressions,
              (SELECT count(*)::int FROM marketing_obligations) obligations,
              (SELECT count(*)::int FROM events) events,
              (SELECT count(*)::int FROM auctions) auctions`)).rows[0];

    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 157 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM marketing_contacts) contacts,
              (SELECT count(*)::int FROM email_suppressions) suppressions,
              (SELECT count(*)::int FROM marketing_obligations) obligations,
              (SELECT count(*)::int FROM events) events,
              (SELECT count(*)::int FROM auctions) auctions,
              (SELECT count(*)::int FROM sales_near_you_entitlements) entitlements`)).rows[0];
    const cfg = {};
    (await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'marketing.email.%'`)).rows
      .forEach((r) => { cfg[r.key] = r.value; });
    const cons = (await c.query(
      `SELECT conname FROM pg_constraint WHERE conname LIKE 'chk_sny_%' ORDER BY 1`)).rows.map((r) => r.conname);
    const idx = (await c.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='sales_near_you_entitlements' ORDER BY 1`)).rows.map((r) => r.indexname);
    const oblCol = (await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='marketing_obligations' AND column_name='event_id'`)).rowCount;
    const paidOn = (await c.query(
      `SELECT key FROM platform_config WHERE key = ANY($1) AND (value='true'::jsonb OR value='"true"'::jsonb)`, [PAID_OFF])).rows.map((r) => r.key);

    const allowed = Array.isArray(cfg['marketing.email.radius_allowed']) ? cfg['marketing.email.radius_allowed'] : [];
    const checks = {
      entitlement_table_empty: after.entitlements === 0,
      obligations_event_aware: oblCol === 1,
      subject_constraint: cons.includes('chk_sny_entitlement_subject'),
      override_reason_constraint: cons.includes('chk_sny_override_reason'),
      one_live_entitlement_per_subject: idx.includes('uq_sny_entitlement_live_auction') && idx.includes('uq_sny_entitlement_live_event'),
      // The Owner's 30-mile decision, on BOTH keys.
      email_radius_is_30: Number(cfg['marketing.email.radius_default_miles']) === 30,
      local_alert_radius_is_30: Number(cfg['marketing.email.local_alert_default_radius_miles']) === 30,
      thirty_is_allowed: allowed.map(Number).includes(30),
      channel_ships_off: cfg['marketing.email.sales_near_you_enabled'] === false,
      obligation_key_named: cfg['marketing.email.sales_near_you_obligation_key'] === 'sales_near_you_email',
      // Nothing about subscribers, suppression or inventory moved.
      contacts_unchanged: after.contacts === before.contacts,
      suppressions_unchanged: after.suppressions === before.suppressions,
      obligations_unchanged: after.obligations === before.obligations,
      events_unchanged: after.events === before.events,
      auctions_unchanged: after.auctions === before.auctions,
      paid_gates_unchanged: paidOn.length === 0,
      ledger: await ledgerHas(c),
    };
    console.log('Before:', JSON.stringify(before));
    console.log('After: ', JSON.stringify(after));
    console.log('Radius:', JSON.stringify({
      email_default: cfg['marketing.email.radius_default_miles'],
      local_alert_default: cfg['marketing.email.local_alert_default_radius_miles'],
      allowed: cfg['marketing.email.radius_allowed'],
    }));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    if (failed.length) console.error('FAILED CHECKS:', failed.join(', '));
    console.log('RESULT: ' + (failed.length ? 'FAIL' : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
