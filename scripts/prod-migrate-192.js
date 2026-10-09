#!/usr/bin/env node
/* prod-migrate-192.js — PRODUCTION-guarded apply of ONLY 192_phone_sasha_timing_menu_voice.sql (turn timing events and
   the separate menu voice). Verifies every Phone Sasha / auction text / bidder phone / Seller Activation switch is
   unchanged, Sasha's own voice is unchanged, the staff test list is unchanged, and no call, consent, text, invoice or
   payment changed. */
const fs = require('fs'); const path = require('path');
const FILE = '192_phone_sasha_timing_menu_voice.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

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
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config WHERE key <> 'sasha.phone.menu_voice'`),
      callers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(removed_at::text,'-'), ',' ORDER BY id), '')) h FROM cs_phone_test_callers`),
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
    const mv = cfg['sasha.phone.menu_voice'] || {};
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      timing_table_empty: (await c.query(`SELECT to_regclass('public.cs_call_timing_events') t`)).rows[0].t !== null && Number((await c.query(`SELECT count(*)::int n FROM cs_call_timing_events`)).rows[0].n) === 0,
      menu_voice_british: mv.tts_provider === 'Amazon' && mv.voice === 'Amy-Generative' && mv.language === 'en-GB',
      phone_sasha_staff_test_state: cfg['sasha.phone.enabled'] === true && cfg['sasha.phone.provider'] === 'twilio_cr' && cfg['sasha.phone.verify_provider'] === 'twilio_verify'
        && cfg['sasha.phone.access_mode'] === 'staff_only' && cfg['sasha.phone.call_notice'] === '',
      auction_sms_off: cfg['auction_sms.enabled'] === false && cfg['auction_sms.a2p_confirmed'] === false && cfg['auction_sms.offer_opt_in'] === false,
      bidder_phone: cfg['bidder_phone.verification_enabled'] === true && cfg['bidder_phone.required'] === false,
      seller_activation_live: cfg['seller_activation.mode'] === 'live',
      other_platform_config_unchanged: before.config === after.config,
      test_callers_unchanged: before.callers === after.callers,
      calls_unchanged: before.calls === after.calls,
      consents_texts_payments_invoices_users_unchanged: before.other === after.other,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
