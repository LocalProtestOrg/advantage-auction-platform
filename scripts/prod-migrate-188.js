#!/usr/bin/env node
/* prod-migrate-188.js — PRODUCTION-guarded apply of ONLY 188_sasha_phone_foundation.sql (phone channel, call / verification /
   session / disclosure-audit tables, callback columns, users.phone_verified_at, sasha.phone.* switches).
   Verifies the phone switch lands OFF with no provider, and that NOTHING else changed: no other platform_config value,
   no users.phone value, no Sasha conversation or message, no seller activation state, no seller fee. */
const fs = require('fs'); const path = require('path');
const FILE = '188_sasha_phone_foundation.sql';
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
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config WHERE key NOT LIKE 'sasha.phone.%'`),
      phones: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(phone,'-'), ',' ORDER BY id), '')) h FROM users`),
      sasha: await h(`SELECT md5((SELECT count(*) FROM cs_conversations)::text || ':' || (SELECT count(*) FROM cs_messages)::text || ':' || (SELECT count(*) FROM cs_handoffs)::text) h`),
      activation: await h(`SELECT md5((SELECT count(*) FROM seller_activation_touches)::text || ':' || (SELECT count(*) FILTER (WHERE mode = 'live') FROM seller_activation_touches)::text) h`),
      seller_fees: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(platform_fee_bps::text,'null'), ',' ORDER BY id), '')) h FROM seller_profiles`),
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
    const cfg = Object.fromEntries((await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'sasha.phone.%'`)).rows.map((r) => [r.key, r.value]));
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      tables: (await reg('public.cs_calls')) && (await reg('public.cs_phone_verifications')) && (await reg('public.cs_phone_sessions')) && (await reg('public.cs_phone_audit')),
      phone_channel_allowed: /'phone'/.test((await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'cs_conversations_channel_check'`)).rows[0].d),
      callback_columns: (await col('cs_handoffs', 'callback_requested')) && (await col('cs_handoffs', 'callback_phone_e164')) && (await col('cs_handoffs', 'callback_status')),
      users_phone_verified_at: await col('users', 'phone_verified_at'),
      phone_switch_off: cfg['sasha.phone.enabled'] === false,
      no_provider: cfg['sasha.phone.provider'] === 'none' && cfg['sasha.phone.verify_provider'] === 'none',
      no_calls: Number((await c.query(`SELECT count(*) n FROM cs_calls`)).rows[0].n) === 0,
      other_platform_config_unchanged: before.config === after.config,
      users_phone_unchanged: before.phones === after.phones,
      no_phone_marked_verified: Number((await c.query(`SELECT count(*) n FROM users WHERE phone_verified_at IS NOT NULL`)).rows[0].n) === 0,
      sasha_conversations_unchanged: before.sasha === after.sasha,
      seller_activation_unchanged: before.activation === after.activation,
      seller_fees_unchanged: before.seller_fees === after.seller_fees,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
