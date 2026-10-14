#!/usr/bin/env node
/* prod-migrate-193.js — PRODUCTION-guarded apply of ONLY 193_storefront_fee_article_buy_now.sql (one paragraph of the
   approved Sasha guidance article "professional-storefront-fee"). Runs in one transaction and verifies that only that
   article changed: every other guidance article, all platform settings, the staff test list, calls, consents, texts,
   payment links, payments, invoices and users are unchanged. */
const fs = require('fs'); const path = require('path');
const FILE = '193_storefront_fee_article_buy_now.sql';
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
      config: await h(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config`),
      otherArticles: await h(`SELECT md5(coalesce(string_agg(slug || ':' || version || ':' || md5(body), ',' ORDER BY slug), '')) h FROM cs_kb_articles WHERE slug <> 'professional-storefront-fee'`),
      callers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(removed_at::text,'-'), ',' ORDER BY id), '')) h FROM cs_phone_test_callers`),
      calls: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || status, ',' ORDER BY id), '')) h FROM cs_calls`),
      other: await h(`SELECT md5(((SELECT count(*) FROM sms_consents) || ':' || (SELECT count(*) FROM auction_sms_messages) || ':' || (SELECT count(*) FROM payment_links)
        || ':' || (SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices) || ':' || (SELECT count(*) FROM users))::text) h`),
    });
    const article = async () => (await c.query(`SELECT version, body FROM cs_kb_articles WHERE slug = 'professional-storefront-fee'`)).rows[0] || null;
    const before = await snap(); const a0 = await article();
    if ((await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount) console.log('SKIP (already recorded).');
    else {
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED', FILE);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    const after = await snap(); const a1 = await article();
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      article_present: !!a1,
      old_paragraph_gone: !!a1 && !a1.body.includes('Storefront checkout is not open to buyers yet'),
      new_paragraph_present: !!a1 && a1.body.includes('Storefronts and Buy Now are Professional Seller features.'),
      fee_paragraph_kept: !!a1 && /11%/.test(a1.body),
      version_bumped_once_or_unchanged: !!a0 && !!a1 && (a1.version === a0.version || a1.version === a0.version + 1),
      platform_config_unchanged: before.config === after.config,
      other_articles_unchanged: before.otherArticles === after.otherArticles,
      test_callers_unchanged: before.callers === after.callers,
      calls_unchanged: before.calls === after.calls,
      consents_texts_links_payments_invoices_users_unchanged: before.other === after.other,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
