#!/usr/bin/env node
/* prod-migrate-190.js — PRODUCTION-guarded apply of ONLY 190_sms_consent_versions_suppression.sql (versioned text-alert
   consent records, the number-level do-not-text list, and the inbound STOP/START/HELP log). Verifies that every
   bidder_phone.*, auction_sms.*, sasha.phone.* and seller_activation.* value is unchanged, that no consent, text,
   suppression or inbound row was created, and that no stored phone, invoice or payment changed. */
const fs = require('fs'); const path = require('path');
const FILE = '190_sms_consent_versions_suppression.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  process.env.DATABASE_URL = raw.replace('-pooler', '');
  const db = require('../src/db');
  const c = await db.connect();
  try {
    const h = async (sql) => (await c.query(sql)).rows[0].h;
    const snap = async () => ({
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config`),
      phones: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(phone,'-') || ':' || coalesce(phone_verified_e164,'-') || ':' || coalesce(phone_verified_at::text,'-'), ',' ORDER BY id), '')) h FROM users`),
      consents: await h(`SELECT md5(((SELECT count(*) FROM sms_consents) || ':' || (SELECT count(*) FROM sms_consent_events) || ':' || (SELECT count(*) FROM auction_sms_messages) || ':' || (SELECT count(*) FROM payment_links))::text) h`),
      invoices: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(total_cents::text,'-'), ',' ORDER BY id), '')) h FROM buyer_auction_invoices`),
      payments: await h(`SELECT md5((SELECT count(*) FROM payments)::text) h`),
    });
    const before = await snap();
    if ((await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount) console.log('SKIP (already recorded).');
    else {
      try {
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));   // file carries BEGIN/COMMIT
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        console.log('APPLIED', FILE);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    const after = await snap();
    const reg = async (n) => !!(await c.query(`SELECT to_regclass($1) AS t`, [n])).rows[0].t;
    const col = async (tb, n) => (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [tb, n])).rowCount === 1;
    const n = async (sql) => Number((await c.query(sql)).rows[0].n);
    const cfg = Object.fromEntries((await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'bidder_phone.%' OR key LIKE 'auction_sms.%' OR key LIKE 'sasha.phone.%' OR key = 'seller_activation.mode'`)).rows.map((r) => [r.key, r.value]));
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      tables: (await reg('public.sms_suppressions')) && (await reg('public.sms_inbound_events')),
      consent_columns: (await col('sms_consents', 'consent_version')) && (await col('sms_consents', 'terms_last_updated')) && (await col('sms_consents', 'surface'))
        && (await col('sms_consent_events', 'consent_version')) && (await col('sms_consent_events', 'privacy_last_updated')),
      no_suppression_or_inbound_rows: await n(`SELECT ((SELECT count(*) FROM sms_suppressions) + (SELECT count(*) FROM sms_inbound_events))::int n`) === 0,
      verification_on_optional: cfg['bidder_phone.verification_enabled'] === true && cfg['bidder_phone.required'] === false,
      auction_sms_off: cfg['auction_sms.enabled'] === false && cfg['auction_sms.a2p_confirmed'] === false && cfg['auction_sms.offer_opt_in'] === false,
      phone_sasha_off: cfg['sasha.phone.enabled'] === false && cfg['sasha.phone.provider'] === 'none' && cfg['sasha.phone.verify_provider'] === 'none',
      seller_activation_live: cfg['seller_activation.mode'] === 'live',
      all_platform_config_unchanged: before.config === after.config,
      phones_unchanged: before.phones === after.phones,
      consents_texts_links_unchanged: before.consents === after.consents,
      invoices_unchanged: before.invoices === after.invoices,
      payments_unchanged: before.payments === after.payments,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
