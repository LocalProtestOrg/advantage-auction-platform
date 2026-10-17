#!/usr/bin/env node
/* prod-verify-204.js — PRODUCTION verification of migration 204 (inventory numbers + seller sale-notice outbox) with
   NOTHING kept and NO email sent: one transaction that always ends in ROLLBACK (uncommitted rows are invisible to the
   live sender). On a demo storefront item it sets an inventory number, creates a temporary demo order, runs the REAL
   production queueing code (storefrontNotificationService.enqueueSalePaid) while the order is pending and after it is
   paid (twice), then attempts every prohibited change. Afterwards it confirms nothing was kept. Prints verdicts only.
   Usage: railway run node scripts/prod-verify-204.js */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const notify = require('../src/services/storefrontNotificationService');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const results = {};
  const state = async () => (await c.query(`SELECT (SELECT count(*) FROM storefront_notifications)::text || ':' || (SELECT count(*) FROM marketplace_orders)::text
    || ':' || md5(coalesce((SELECT string_agg(id::text || coalesce(inventory_number,''), ',' ORDER BY id) FROM marketplace_items), '')) s`)).rows[0].s;
  try {
    const before = await state();
    await c.query('BEGIN'); await c.query(`SET LOCAL statement_timeout = '15s'`);
    const item = (await c.query(`SELECT mi.*, sp.user_id AS seller_user_id FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.is_demo AND mi.status = 'active' ORDER BY mi.created_at LIMIT 1`)).rows[0];
    const buyer = (await c.query(`SELECT id FROM users WHERE lower(email) = 'validation-buyer@advantage.bid'`)).rows[0];
    const other = (await c.query('SELECT id FROM seller_profiles WHERE id <> $1 ORDER BY created_at LIMIT 1', [item.seller_id])).rows[0];
    const mustFail = async (name, sql, p) => {
      await c.query('SAVEPOINT t');
      try { await c.query(sql, p); results[name] = 'NOT BLOCKED'; }
      catch (e) { results[name] = (['23514', '23505', '23503'].includes(e.code) ? 'blocked ' : 'UNEXPECTED ') + e.code; }
      await c.query('ROLLBACK TO SAVEPOINT t');
    };
    await c.query(`UPDATE marketplace_items SET inventory_number = 'VERIFY-204' WHERE id = $1`, [item.id]);
    await mustFail('duplicate inventory number in the same seller', `INSERT INTO marketplace_items (seller_id, title, price_cents, status, inventory_number, is_demo) VALUES ($1,'dup',100,'draft','verify-204',true)`, [item.seller_id]);
    const snap = { item_id: item.id, title: item.title, inventory_number: 'VERIFY-204', listed_price_cents: item.price_cents };
    const o = (await c.query(
      `INSERT INTO marketplace_orders (order_number, marketplace_item_id, seller_id, buyer_user_id, item_price_cents, total_charge_cents, platform_fee_bps,
         platform_fee_cents, seller_proceeds_cents, fulfillment_method, is_demo, item_snapshot, seller_snapshot)
       VALUES ('MO-VERIFY-204', $1, $2, $3, $4, $4, 1100, ($4 * 11 / 100), $4 - ($4 * 11 / 100), 'pickup', true, $5::jsonb, $6::jsonb) RETURNING id`,
      [item.id, item.seller_id, buyer.id, item.price_cents, JSON.stringify(snap), JSON.stringify({ seller_profile_id: item.seller_id })])).rows[0];
    await notify.enqueueSalePaid(c, o.id);
    results['nothing queued while payment is pending'] = Number((await c.query('SELECT count(*)::int n FROM storefront_notifications WHERE order_id = $1', [o.id])).rows[0].n) === 0 ? 'ok' : 'FAILED';
    await c.query(`UPDATE marketplace_orders SET payment_status = 'paid', paid_at = now() WHERE id = $1`, [o.id]);
    await notify.enqueueSalePaid(c, o.id);
    await notify.enqueueSalePaid(c, o.id);   // a repeated payment confirmation
    const rows = (await c.query('SELECT * FROM storefront_notifications WHERE order_id = $1', [o.id])).rows;
    results['exactly one notice after payment (repeat ignored)'] = rows.length === 1 ? 'ok' : 'FAILED ' + rows.length;
    results['notice names the order\'s own seller, demo flag from the order'] = rows[0] && rows[0].seller_id === item.seller_id && rows[0].is_demo === true ? 'ok' : 'FAILED';
    results['order snapshot keeps the inventory number'] = (await c.query('SELECT item_snapshot->>\'inventory_number\' AS n FROM marketplace_orders WHERE id = $1', [o.id])).rows[0].n === 'VERIFY-204' ? 'ok' : 'FAILED';
    await mustFail('notice for another seller\'s order', `INSERT INTO storefront_notifications (seller_id, order_id, event, recipient_email) VALUES ($1,$2,'sale_paid','x@example.com')`, [other.id, o.id]);
    await mustFail('change the recipient', `UPDATE storefront_notifications SET recipient_email = 'evil@example.com' WHERE id = $1`, [rows[0].id]);
    await mustFail('flip the demo flag', `UPDATE storefront_notifications SET is_demo = false WHERE id = $1`, [rows[0].id]);
    await c.query(`UPDATE storefront_notifications SET status = 'sent', sent_at = now() WHERE id = $1`, [rows[0].id]);
    await mustFail('a sent notice back to pending', `UPDATE storefront_notifications SET status = 'pending' WHERE id = $1`, [rows[0].id]);
    await mustFail('rewrite the order snapshot', `UPDATE marketplace_orders SET item_snapshot = item_snapshot || '{"inventory_number":"X"}'::jsonb WHERE id = $1`, [o.id]);
    const msg = notify.renderSalePaid({ ...(await c.query('SELECT * FROM marketplace_orders WHERE id = $1', [o.id])).rows[0] });
    const all = msg.subject + msg.html + msg.text;
    results['email content: item, number, price, fee, estimate, link'] = ['VERIFY-204', 'MO-VERIFY-204', '11% of the item price', 'Estimated proceeds', '/seller-orders.html'].every((s) => all.includes(s)) ? 'ok' : 'FAILED';
    // The only address in the email is the Advantage.Bid help address; the buyer's email must not appear.
    const addresses = (all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter((x) => x.toLowerCase() !== 'info@advantage.bid');
    results['email content: no buyer data'] = (!addresses.length && !/validation-buyer/i.test(all)) ? 'ok' : 'FAILED ' + addresses.join(',');
    await c.query('ROLLBACK');
    results['nothing kept (no notice, order or number committed; no email sent)'] = (await state()) === before ? 'ok' : 'FAILED';
    console.log(JSON.stringify(results, null, 2));
    const bad = Object.entries(results).filter(([, x]) => !String(x).startsWith('blocked') && x !== 'ok');
    console.log('RESULT: ' + (bad.length ? 'FAIL ' + bad.map(([k]) => k).join('; ') : 'PASS'));
    return bad.length ? 1 : 0;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('ERROR', e.message); return 1; }
  finally { await c.end(); }
})().then((code) => process.exit(code || 0));
