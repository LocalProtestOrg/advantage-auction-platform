#!/usr/bin/env node
/* prod-verify-206.js — PRODUCTION verification of migration 206 (sold-item price privacy; message hiding) with NOTHING
   kept and NO email sent: one transaction that always ends in ROLLBACK. On a demo storefront item it creates a temporary
   paid demo order, marks the item sold, and runs the REAL production code (marketplaceItemService.getPublicItem and
   productPageService.render) as the public, as a signed-in member with the setting off, and with it on. It then checks
   the message-hiding rules on a temporary demo conversation. Prints verdicts only (no prices or message text).
   Usage: railway run node scripts/prod-verify-206.js */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const items = require('../src/services/marketplaceItemService');
  const pages = require('../src/services/productPageService');
  const productData = require('../src/lib/productData');
  const messaging = require('../src/services/storefrontMessagingService');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const results = {};
  const state = async () => (await c.query(`SELECT md5(coalesce((SELECT string_agg(id::text || status || show_realized_price_to_members::text, ',' ORDER BY id) FROM marketplace_items), ''))
    || ':' || (SELECT count(*) FROM marketplace_orders)::text || ':' || (SELECT count(*) FROM storefront_messages)::text || ':' || (SELECT count(*) FROM storefront_notifications)::text s`)).rows[0].s;
  try {
    const before = await state();
    await c.query('BEGIN'); await c.query(`SET LOCAL statement_timeout = '15s'`);
    const item = (await c.query(`SELECT * FROM marketplace_items WHERE is_demo AND status = 'active' ORDER BY created_at LIMIT 1`)).rows[0];
    const buyer = (await c.query(`SELECT id FROM users WHERE lower(email) = 'validation-buyer@advantage.bid'`)).rows[0];
    const mustFail = async (name, sql, p) => {
      await c.query('SAVEPOINT t');
      try { await c.query(sql, p); results[name] = 'NOT BLOCKED'; }
      catch (e) { results[name] = (['23514', '23505', '23503'].includes(e.code) ? 'blocked ' : 'UNEXPECTED ') + e.code; }
      await c.query('ROLLBACK TO SAVEPOINT t');
    };
    const price = Number(item.price_cents);
    const leak = (s) => s.includes(String(price)) || s.includes(productData.priceString(price));
    results['setting is off for this item'] = item.show_realized_price_to_members === false ? 'ok' : 'FAILED';
    const pub0 = await items.getPublicItem(item.id, c);
    results['an unsold item still shows its price'] = pub0.price_cents === price ? 'ok' : 'FAILED';

    const snap = { item_id: item.id, title: item.title, listed_price_cents: price };
    const o = (await c.query(
      `INSERT INTO marketplace_orders (order_number, marketplace_item_id, seller_id, buyer_user_id, item_price_cents, total_charge_cents, platform_fee_bps,
         platform_fee_cents, seller_proceeds_cents, fulfillment_method, is_demo, item_snapshot, seller_snapshot)
       VALUES ('MO-VERIFY-206', $1, $2, $3, $4, $4, 1100, ($4 * 11 / 100), $4 - ($4 * 11 / 100), 'pickup', true, $5::jsonb, $6::jsonb) RETURNING id`,
      [item.id, item.seller_id, buyer.id, price, JSON.stringify(snap), JSON.stringify({ seller_profile_id: item.seller_id })])).rows[0];
    await c.query(`UPDATE marketplace_orders SET payment_status = 'paid', paid_at = now() WHERE id = $1`, [o.id]);
    await c.query(`UPDATE marketplace_items SET status = 'sold', updated_at = now() WHERE id = $1`, [item.id]);

    const pub = await items.getPublicItem(item.id, c);
    results['public API: sold, no price or shipping charge'] = pub.status === 'sold' && pub.price_cents === null && pub.shipping_cost_cents === null
      && pub.realized_price_cents === undefined && !leak(JSON.stringify(pub)) ? 'ok' : 'FAILED';
    const page = await pages.render(item.id, productData.slugify(item.title), 'https://bid.advantage.bid', c);
    results['public page + structured data: SOLD, SoldOut, no price'] = page.status === '200' || page.status === 200
      ? (page.html && !leak(page.html) && page.html.includes('SOLD') && page.html.includes('schema.org/SoldOut') && !page.html.includes('product:price:amount') ? 'ok' : 'FAILED')
      : 'FAILED status ' + page.status;
    const memberOff = await items.getPublicItem(item.id, c, { viewerUserId: buyer.id });
    results['member, setting off: no realized price'] = memberOff.realized_price_cents === undefined && !leak(JSON.stringify(memberOff)) ? 'ok' : 'FAILED';
    await c.query(`UPDATE marketplace_items SET show_realized_price_to_members = true WHERE id = $1`, [item.id]);
    const memberOn = await items.getPublicItem(item.id, c, { viewerUserId: buyer.id });
    results['member, setting on: realized item price, labelled fixed-price sale'] = memberOn.realized_price_cents === price && memberOn.realized_price_label === 'Fixed-price sale' ? 'ok' : 'FAILED';
    const pubOn = await items.getPublicItem(item.id, c);
    results['public, setting on: still no price'] = !leak(JSON.stringify(pubOn)) && pubOn.realized_price_cents === undefined ? 'ok' : 'FAILED';

    // message hiding rules on a temporary demo conversation (the item is sold now, so use the conversation directly)
    const conv = (await c.query(`INSERT INTO storefront_conversations (seller_id, item_id, buyer_user_id, subject_snapshot) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING *`,
      [item.seller_id, item.id, buyer.id])).rows[0];
    const m = (await messaging.insertMessage(c, conv, 'buyer', buyer.id, 'Is the veneer original on the drawer fronts?', null)).message;
    await mustFail('hide without a reason', `UPDATE storefront_messages SET hidden_at = now() WHERE id = $1`, [m.id]);
    await c.query(`UPDATE storefront_messages SET hidden_at = now(), hidden_by = $2, hidden_reason = 'Verification only' WHERE id = $1`, [m.id, buyer.id]);
    await mustFail('unhide a hidden message', `UPDATE storefront_messages SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL WHERE id = $1`, [m.id]);
    await mustFail('rewrite the hide reason', `UPDATE storefront_messages SET hidden_reason = 'changed reason' WHERE id = $1`, [m.id]);
    await mustFail('a review action outside the list', `INSERT INTO storefront_message_reviews (message_id, seller_id, action, actor_user_id) VALUES ($1, $2, 'deleted', $3)`,
      [m.id, item.seller_id, buyer.id]);

    await c.query('ROLLBACK');
    results['nothing kept (no order, sale, setting, conversation, message or notice committed; no email sent)'] = (await state()) === before ? 'ok' : 'FAILED';
    console.log(JSON.stringify(results, null, 2));
    const bad = Object.entries(results).filter(([, x]) => !String(x).startsWith('blocked') && x !== 'ok');
    console.log('RESULT: ' + (bad.length ? 'FAIL ' + bad.map(([k]) => k).join('; ') : 'PASS'));
    return bad.length ? 1 : 0;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('ERROR', e.message); return 1; }
  finally { await c.end(); }
})().then((code) => process.exit(code || 0));
