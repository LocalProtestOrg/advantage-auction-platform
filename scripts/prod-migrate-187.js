#!/usr/bin/env node
/* prod-migrate-187.js — PRODUCTION-guarded apply of ONLY 187_seller_activation.sql (seller_activation_state,
   seller_activation_touches, founding_partners.sasha_assist_released_*, seller_activation.* switches).
   Verifies the switches land in SHADOW (enabled = true, mode = 'shadow'), that no Auction Partner is released to Sasha,
   and that NOTHING else changed: no other platform_config value, no seller fee, no agreement, no Sasha conversation or
   message, no founding partner fee/status. */
const fs = require('fs'); const path = require('path');
const FILE = '187_seller_activation.sql';
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
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config WHERE key NOT LIKE 'seller_activation.%'`),
      seller_fees: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(platform_fee_bps::text,'null') || ':' || coalesce(agreement_waived_at::text,'-'), ',' ORDER BY id), '')) h FROM seller_profiles`),
      agreements: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status, ',' ORDER BY id), '')) h FROM agreements`),
      sasha: await h(`SELECT md5((SELECT count(*) FROM cs_conversations)::text || ':' || (SELECT count(*) FROM cs_messages)::text) h`),
      partners: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || intro_platform_fee_bps || ':' || coalesce(seller_profile_id::text,'-'), ',' ORDER BY id), '')) h FROM founding_partners`),
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
    const cfg = Object.fromEntries((await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'seller_activation.%'`)).rows.map((r) => [r.key, r.value]));
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      state_table: await reg('public.seller_activation_state'),
      touches_table: await reg('public.seller_activation_touches'),
      fp_release_columns: (await col('founding_partners', 'sasha_assist_released_at')) && (await col('founding_partners', 'sasha_assist_released_by')),
      enabled_true: cfg['seller_activation.enabled'] === true,
      mode_shadow: cfg['seller_activation.mode'] === 'shadow',
      timing_72h_7d: Number(cfg['seller_activation.first_touch_hours']) === 72 && Number(cfg['seller_activation.second_touch_days']) === 7,
      caps_2_3: Number(cfg['seller_activation.max_per_stage']) === 2 && Number(cfg['seller_activation.max_per_seller']) === 3,
      no_live_touches: Number((await c.query(`SELECT count(*) n FROM seller_activation_touches WHERE mode = 'live'`)).rows[0].n) === 0,
      no_partner_released: Number((await c.query(`SELECT count(*) n FROM founding_partners WHERE sasha_assist_released_at IS NOT NULL`)).rows[0].n) === 0,
      other_platform_config_unchanged: before.config === after.config,
      seller_fees_and_waivers_unchanged: before.seller_fees === after.seller_fees,
      agreements_unchanged: before.agreements === after.agreements,
      sasha_conversations_unchanged: before.sasha === after.sasha,
      partners_unchanged: before.partners === after.partners,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
