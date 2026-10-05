#!/usr/bin/env node
/* prod-migrate-186.js — PRODUCTION-guarded apply of ONLY 186_auction_partner_actual_processing.sql (auctions.processing_fee_basis,
   payments.stripe_refund_fee_*). Additive and nullable: every existing auction stays NULL (existing rules). Verifies the
   columns landed and that NOTHING else changed: no platform_config value (fees, switches), no seller rate, no auction
   pricing, no payment amount or fee, no settlement figure. */
const fs = require('fs'); const path = require('path');
const FILE = '186_auction_partner_actual_processing.sql';
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
      seller_fees: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(platform_fee_bps::text,'null'), ',' ORDER BY id), '')) h FROM seller_profiles`),
      auction_pricing: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(platform_fee_bps::text,'-') || ':' || coalesce(processing_fee_bps::text,'-') || ':' || coalesce(pricing_model,'-'), ',' ORDER BY id), '')) h FROM auctions`),
      payments: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || amount_cents || ':' || status || ':' || coalesce(stripe_fee_cents::text,'-') || ':' || coalesce(refunded_amount_cents::text,'-'), ',' ORDER BY id), '')) h FROM payments`),
      payouts: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(seller_payout_cents::text,'-') || ':' || coalesce(processing_fee_cents::text,'-') || ':' || settlement_status, ',' ORDER BY id), '')) h FROM seller_payouts`),
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
    const col = async (t, n) => (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, n])).rowCount === 1;
    const cfg = Object.fromEntries((await c.query(`SELECT key, value FROM platform_config WHERE key IN
      ('pricing.auction.professional.platform_fee_bps','pricing.auction.processing_fee_bps','pricing.storefront.seller_fee_bps',
       'claimed_listings.sending_enabled','event_partners.outreach_enabled')`)).rows.map((r) => [r.key, r.value]));
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      auctions_processing_fee_basis: await col('auctions', 'processing_fee_basis'),
      payments_refund_fee_columns: (await col('payments', 'stripe_refund_fee_cents')) && (await col('payments', 'stripe_refund_fee_refunded_cents')) && (await col('payments', 'stripe_refund_fee_captured_at')),
      no_auction_has_actual_basis: Number((await c.query(`SELECT count(*) n FROM auctions WHERE processing_fee_basis IS NOT NULL`)).rows[0].n) === 0,
      platform_config_unchanged: before.config === after.config,
      seller_fees_unchanged: before.seller_fees === after.seller_fees,
      auction_pricing_unchanged: before.auction_pricing === after.auction_pricing,
      payments_unchanged: before.payments === after.payments,
      payouts_unchanged: before.payouts === after.payouts,
      pro_fee_400: Number(cfg['pricing.auction.professional.platform_fee_bps']) === 400,
      processing_300: Number(cfg['pricing.auction.processing_fee_bps']) === 300,
      storefront_1100: Number(cfg['pricing.storefront.seller_fee_bps']) === 1100,
      claimed_listing_sending_off: cfg['claimed_listings.sending_enabled'] === false,
      event_partner_outreach_off: cfg['event_partners.outreach_enabled'] === false,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await db.pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
