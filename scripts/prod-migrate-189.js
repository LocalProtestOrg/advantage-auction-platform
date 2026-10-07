#!/usr/bin/env node
/* prod-migrate-189.js — PRODUCTION-guarded apply of ONLY 189_bidder_phone_sms_paylinks.sql (verified bidder phones,
   opt-in auction texts, Phone Sasha email verification + payment links). Verifies every new switch lands OFF, that no
   existing phone is marked verified, that no consent or text exists, and that NOTHING else changed: no stored phone, no
   other platform_config value (beyond the two Phone Sasha code limits), no Sasha conversation, no seller activation
   record, no invoice or payment. */
const fs = require('fs'); const path = require('path');
const FILE = '189_bidder_phone_sms_paylinks.sql';
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
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config
        WHERE key NOT LIKE 'bidder_phone.%' AND key NOT LIKE 'auction_sms.%' AND key NOT IN ('sasha.phone.code_ttl_minutes','sasha.phone.code_max_attempts')`),
      phones: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(phone,'-'), ',' ORDER BY id), '')) h FROM users`),
      sasha: await h(`SELECT md5((SELECT count(*) FROM cs_conversations)::text || ':' || (SELECT count(*) FROM cs_messages)::text) h`),
      activation: await h(`SELECT md5((SELECT count(*) FROM seller_activation_touches)::text) h`),
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
    const cfg = Object.fromEntries((await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'bidder_phone.%' OR key LIKE 'auction_sms.%' OR key LIKE 'sasha.phone.%'`)).rows.map((r) => [r.key, r.value]));
    const n = async (sql) => Number((await c.query(sql)).rows[0].n);
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      tables: (await reg('public.account_phone_verifications')) && (await reg('public.payment_links')) && (await reg('public.sms_consents'))
        && (await reg('public.sms_consent_events')) && (await reg('public.auction_sms_messages')),
      user_columns: (await col('users', 'phone_verified_e164')) && (await col('users', 'phone_changed_at')),
      phone_verification_channel: await col('cs_phone_verifications', 'channel'),
      all_new_switches_off: ['bidder_phone.required', 'bidder_phone.verification_enabled', 'auction_sms.enabled', 'auction_sms.a2p_confirmed', 'auction_sms.offer_opt_in']
        .every((k) => cfg[k] === false),
      cooldown_5_reminder_60: Number(cfg['auction_sms.outbid_cooldown_minutes']) === 5 && Number(cfg['auction_sms.watched_reminder_minutes']) === 60,
      phone_sasha_still_off: cfg['sasha.phone.enabled'] === false && cfg['sasha.phone.provider'] === 'none',
      four_digit_code_limits: Number(cfg['sasha.phone.code_ttl_minutes']) === 5 && Number(cfg['sasha.phone.code_max_attempts']) === 3,
      no_phone_marked_verified: await n(`SELECT count(*)::int n FROM users WHERE phone_verified_at IS NOT NULL OR phone_verified_e164 IS NOT NULL`) === 0,
      no_consents_no_texts_no_links: await n(`SELECT ((SELECT count(*) FROM sms_consents) + (SELECT count(*) FROM auction_sms_messages) + (SELECT count(*) FROM payment_links))::int n`) === 0,
      stored_phones_unchanged: before.phones === after.phones,
      other_platform_config_unchanged: before.config === after.config,
      sasha_conversations_unchanged: before.sasha === after.sasha,
      seller_activation_unchanged: before.activation === after.activation,
      invoices_unchanged: before.invoices === after.invoices,
      payments_unchanged: before.payments === after.payments,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
