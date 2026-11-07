#!/usr/bin/env node
/* audit-marketing-package-purchases.js — READ-ONLY audit of seller advertising purchases (Marketing Packages and
   Additional Promotions) and the state of every fulfillment obligation they created.

   Prints, per purchase: kind, package/promotion, status, amount, purchase date, auction id, whether the buyer owns that
   auction (seller profile match), and each obligation's key, channel, category and state, flagging obligations on the
   paid channel (which cannot be fulfilled while paid fulfillment is not live) and obligations recorded as complete on a
   paid channel. Ends with totals.

   Prints NO card data, Stripe identifiers, names, email addresses, phone numbers or confidential economics (policy %,
   internal authority). Opens a READ ONLY transaction; nothing is written.

   Usage: railway run node scripts/audit-marketing-package-purchases.js [--since=YYYY-MM-DD] [--json] */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const arg = (name) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : null; };
const JSON_OUT = process.argv.includes('--json');
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const since = arg('since');
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.error('REFUSE: --since must be YYYY-MM-DD.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const purchases = (await c.query(
      `SELECT 'package' AS kind, p.id, p.package_key AS item, p.package_version AS version, p.status, p.amount_paid_cents,
              p.purchased_at, p.auction_id, (sp.user_id IS NOT NULL AND sp.user_id = p.seller_user_id) AS buyer_owns_auction
         FROM marketing_package_purchases p
         LEFT JOIN auctions a ON a.id = p.auction_id LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE ($1::date IS NULL OR p.purchased_at >= $1::date)
       UNION ALL
       SELECT 'additional_promotion', x.id, x.promotion_key, x.version, x.status, x.amount_paid_cents,
              x.purchased_at, x.auction_id, (sp.user_id IS NOT NULL AND sp.user_id = x.seller_user_id)
         FROM marketing_additional_promotions x
         LEFT JOIN auctions a ON a.id = x.auction_id LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE ($1::date IS NULL OR x.purchased_at >= $1::date)
        ORDER BY purchased_at`, [since])).rows;
    const obligations = (await c.query(
      `SELECT purchase_kind, purchase_id, obligation_key, channel, category, state, updated_at
         FROM marketing_obligations WHERE purchase_id = ANY($1::uuid[]) ORDER BY purchase_id, category, obligation_key`,
      [purchases.map((p) => p.id)])).rows;
    await c.query('ROLLBACK');

    const done = ['completed', 'substituted', 'made_good', 'live'];
    const report = purchases.map((p) => {
      const obs = obligations.filter((o) => o.purchase_id === p.id && o.purchase_kind === p.kind);
      return {
        kind: p.kind, id: p.id, item: p.item, version: p.version, status: p.status,
        amount_usd: (Number(p.amount_paid_cents) / 100).toFixed(2), purchased_at: p.purchased_at,
        auction_id: p.auction_id, buyer_owns_auction: p.auction_id ? !!p.buyer_owns_auction : null,
        obligations: obs.map((o) => ({ key: o.obligation_key, channel: o.channel, category: o.category, state: o.state,
          paid_channel: o.channel === 'paid', recorded_complete_on_paid_channel: o.channel === 'paid' && done.includes(o.state) })),
      };
    });
    const totals = {
      purchases: report.length,
      paid: report.filter((r) => r.status === 'paid').length,
      pending: report.filter((r) => r.status === 'pending').length,
      paid_amount_usd: report.filter((r) => r.status === 'paid').reduce((t, r) => t + Number(r.amount_usd), 0).toFixed(2),
      purchases_for_an_auction_the_buyer_does_not_own: report.filter((r) => r.buyer_owns_auction === false).length,
      purchases_without_an_auction: report.filter((r) => !r.auction_id).length,
      obligations: obligations.length,
      obligations_on_paid_channel: obligations.filter((o) => o.channel === 'paid').length,
      paid_channel_obligations_recorded_complete: obligations.filter((o) => o.channel === 'paid' && done.includes(o.state)).length,
      obligations_open: obligations.filter((o) => !done.includes(o.state)).length,
    };
    if (JSON_OUT) { console.log(JSON.stringify({ since: since || null, totals, purchases: report }, null, 2)); return 0; }
    for (const r of report) {
      console.log(`${r.purchased_at ? new Date(r.purchased_at).toISOString().slice(0, 10) : '?'}  ${r.kind.padEnd(20)} ${String(r.item).padEnd(10)} v${r.version}  ${r.status.padEnd(7)} $${r.amount_usd.padStart(8)}  auction ${r.auction_id || '(none)'}${r.buyer_owns_auction === false ? '  NOT THE BUYER\'S AUCTION' : ''}`);
      for (const o of r.obligations) {
        console.log(`      ${o.category.padEnd(13)} ${o.channel.padEnd(9)} ${o.state.padEnd(14)} ${o.key}${o.recorded_complete_on_paid_channel ? '  <- PAID CHANNEL RECORDED COMPLETE' : (o.paid_channel ? '  <- paid channel (not deliverable yet)' : '')}`);
      }
    }
    console.log('\nTotals:', JSON.stringify(totals, null, 2));
    return 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e.message); process.exit(1); });
