#!/usr/bin/env node
/* prod-migrate-191.js — PRODUCTION-guarded apply of ONLY 191_phone_sasha_live_relay.sql (routing reason column, the
   staff test-caller allowlist, and the menu / greeting / access settings). Verifies Phone Sasha stays OFF with no
   provider, access is staff-only with an empty test list, every other setting is unchanged (auction texts, bidder phone,
   Seller Activation), and no call, consent, text, invoice or payment changed. */
const fs = require('fs'); const path = require('path');
const FILE = '191_phone_sasha_live_relay.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const NEW_KEYS = ['sasha.phone.access_mode', 'sasha.phone.greeting', 'sasha.phone.menu_text', 'sasha.phone.call_notice'];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  process.env.DATABASE_URL = raw.replace('-pooler', '');
  const db = require('../src/db');
  const c = await db.connect();
  try {
    const h = async (sql, p) => (await c.query(sql, p)).rows[0].h;
    const snap = async () => ({
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config WHERE NOT (key = ANY($1::text[]))`, [NEW_KEYS]),
      calls: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status, ',' ORDER BY id), '')) h FROM cs_calls`),
      other: await h(`SELECT md5(((SELECT count(*) FROM sms_consents) || ':' || (SELECT count(*) FROM auction_sms_messages) || ':' || (SELECT count(*) FROM payment_links)
        || ':' || (SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM users))::text) h`),
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
    const cfg = Object.fromEntries((await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'sasha.phone.%' OR key LIKE 'auction_sms.%' OR key LIKE 'bidder_phone.%' OR key = 'seller_activation.mode'`)).rows.map((r) => [r.key, r.value]));
    const n = async (sql) => Number((await c.query(sql)).rows[0].n);
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      routing_column: (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='cs_calls' AND column_name='routing_reason'`)).rowCount === 1,
      test_caller_table_empty: (await c.query(`SELECT to_regclass('public.cs_phone_test_callers') t`)).rows[0].t !== null && await n(`SELECT count(*)::int n FROM cs_phone_test_callers`) === 0,
      phone_sasha_off: cfg['sasha.phone.enabled'] === false && cfg['sasha.phone.provider'] === 'none' && cfg['sasha.phone.verify_provider'] === 'none',
      staff_only: cfg['sasha.phone.access_mode'] === 'staff_only',
      greeting_and_menu: cfg['sasha.phone.greeting'] === 'Thank you for calling Advantage.Bid. This is Sasha. How can I help you today?'
        && String(cfg['sasha.phone.menu_text']).startsWith('Thank you for calling Advantage.Bid, where you always get the advantage!') && cfg['sasha.phone.call_notice'] === '',
      auction_sms_off: cfg['auction_sms.enabled'] === false && cfg['auction_sms.a2p_confirmed'] === false && cfg['auction_sms.offer_opt_in'] === false,
      bidder_phone: cfg['bidder_phone.verification_enabled'] === true && cfg['bidder_phone.required'] === false,
      seller_activation_live: cfg['seller_activation.mode'] === 'live',
      other_platform_config_unchanged: before.config === after.config,
      calls_unchanged: before.calls === after.calls,
      consents_texts_payments_invoices_users_unchanged: before.other === after.other,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
