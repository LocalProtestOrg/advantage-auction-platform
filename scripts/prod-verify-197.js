#!/usr/bin/env node
/* prod-verify-197.js — PRODUCTION verification of migration 197's database protections, with NOTHING kept.
   Everything runs inside ONE transaction on the direct endpoint that always ends in ROLLBACK: a temporary DEMO order is
   created on the demo storefront item and every prohibited change is attempted (each inside a savepoint). The only lasting
   effect is that one order number in the MO- sequence is skipped (sequences are not transactional).
   Afterwards it confirms (read-only) that no order exists and the items are unchanged. Prints counts/verdicts only.
   Usage: railway run node scripts/prod-verify-197.js */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });   // never the pooler
  await c.connect();
  const results = {};
  const itemsHash = async () => (await c.query(`SELECT md5(coalesce(string_agg(id::text||':'||seller_id::text||':'||status||':'||price_cents, ',' ORDER BY id),'')) h FROM marketplace_items`)).rows[0].h;
  try {
    const beforeItems = await itemsHash();
    const beforeOrders = Number((await c.query('SELECT count(*)::int n FROM marketplace_orders')).rows[0].n);
    await c.query('BEGIN');
    await c.query(`SET LOCAL statement_timeout = '15s'`);
    const item = (await c.query(`SELECT mi.id, mi.seller_id, sp.user_id AS seller_user FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE sp.is_demo = true ORDER BY mi.created_at LIMIT 1`)).rows[0];
    const other = (await c.query('SELECT id FROM seller_profiles WHERE id <> $1 ORDER BY created_at LIMIT 1', [item.seller_id])).rows[0];
    const buyer = (await c.query(`SELECT id FROM users WHERE lower(email) = 'validation-buyer@advantage.bid'`)).rows[0];
    if (!item || !other || !buyer) throw new Error('fixtures missing (demo item / second seller / validation buyer)');

    // must FAIL: each attempt runs in a savepoint and is rolled back to it
    const mustFail = async (name, sql, p) => {
      await c.query('SAVEPOINT t');
      try { await c.query(sql, p); results[name] = 'NOT BLOCKED'; await c.query('ROLLBACK TO SAVEPOINT t'); }
      catch (e) { results[name] = (['23514', '23503'].includes(e.code) ? 'blocked ' : 'UNEXPECTED ') + e.code + ': ' + String(e.message).slice(0, 70); await c.query('ROLLBACK TO SAVEPOINT t'); }
    };
    const snap = (sellerId) => [JSON.stringify({ item_id: item.id }), JSON.stringify({ seller_profile_id: sellerId })];
    const ins = `INSERT INTO marketplace_orders (marketplace_item_id, seller_id, buyer_user_id, item_price_cents, total_charge_cents, fulfillment_method,
      is_demo, item_snapshot, seller_snapshot) VALUES ($1, $2, $3, 1000, 1000, 'pickup', true, $4, $5) RETURNING id`;

    await mustFail('order naming another seller for the item', ins, [item.id, other.id, buyer.id, ...snap(other.id)]);
    await mustFail('snapshot naming another seller', ins, [item.id, item.seller_id, buyer.id, ...snap(other.id)]);
    await mustFail('seller buying own item', ins, [item.id, item.seller_id, item.seller_user, ...snap(item.seller_id)]);
    await mustFail('order created already paid', ins.replace(`'pickup', true`, `'pickup', true`).replace('fulfillment_method,', 'fulfillment_method, payment_status,').replace(`'pickup',`, `'pickup', 'paid',`),
      [item.id, item.seller_id, buyer.id, ...snap(item.seller_id)]);

    // a valid temporary demo order (rolled back at the end)
    const o = (await c.query(ins, [item.id, item.seller_id, buyer.id, ...snap(item.seller_id)])).rows[0];
    results['valid order accepted'] = o ? 'ok' : 'FAILED';
    await c.query(`UPDATE marketplace_orders SET stripe_payment_intent_id = 'pi_verify_rollback', payment_status = 'paid', paid_at = now() WHERE id = $1`, [o.id]);
    results['payment recorded'] = 'ok';

    await mustFail('change seller after payment', 'UPDATE marketplace_orders SET seller_id = $2 WHERE id = $1', [o.id, other.id]);
    await mustFail('change buyer after payment', 'UPDATE marketplace_orders SET buyer_user_id = $2 WHERE id = $1', [o.id, item.seller_user]);
    await mustFail('change price after payment', 'UPDATE marketplace_orders SET item_price_cents = 1 WHERE id = $1', [o.id]);
    await mustFail('change proceeds after payment', 'UPDATE marketplace_orders SET seller_proceeds_cents = 999999 WHERE id = $1', [o.id]);
    await mustFail('change total after payment', 'UPDATE marketplace_orders SET total_charge_cents = 1 WHERE id = $1', [o.id]);
    await mustFail('change payment reference', `UPDATE marketplace_orders SET stripe_payment_intent_id = 'pi_other' WHERE id = $1`, [o.id]);
    await mustFail('change snapshot', `UPDATE marketplace_orders SET seller_snapshot = '{}'::jsonb WHERE id = $1`, [o.id]);
    await mustFail('paid back to pending', `UPDATE marketplace_orders SET payment_status = 'pending' WHERE id = $1`, [o.id]);
    await mustFail('payout eligible before fulfillment', 'UPDATE marketplace_orders SET payout_eligible = true WHERE id = $1', [o.id]);
    await mustFail('change item owner once ordered', 'UPDATE marketplace_items SET seller_id = $2 WHERE id = $1', [item.id, other.id]);
    await mustFail('history naming another seller', `INSERT INTO marketplace_order_events (order_id, seller_id, buyer_user_id, event_type, actor_role) VALUES ($1,$2,$3,'x','system')`, [o.id, other.id, buyer.id]);
    await c.query(`INSERT INTO marketplace_order_events (order_id, seller_id, buyer_user_id, event_type, actor_role) VALUES ($1,$2,$3,'verify','system')`, [o.id, item.seller_id, buyer.id]);
    await mustFail('rewrite history', `UPDATE marketplace_order_events SET event_type = 'y' WHERE order_id = $1`, [o.id]);
    await mustFail('issue naming another seller', `INSERT INTO marketplace_order_issues (order_id, seller_id, buyer_user_id, category, message) VALUES ($1,$2,$3,'other','verify')`, [o.id, other.id, buyer.id]);
    await mustFail('issue naming another buyer', `INSERT INTO marketplace_order_issues (order_id, seller_id, buyer_user_id, category, message) VALUES ($1,$2,$3,'other','verify')`, [o.id, item.seller_id, item.seller_user]);
    await mustFail('chargeback naming another seller', `INSERT INTO payment_disputes (stripe_dispute_id, status, marketplace_order_id, marketplace_seller_id) VALUES ('dp_verify','x',$1,$2)`, [o.id, other.id]);
    await c.query('UPDATE marketplace_orders SET fulfillment_status = $2 WHERE id = $1', [o.id, 'ready_for_pickup']);
    await mustFail('fulfillment moving backwards', `UPDATE marketplace_orders SET fulfillment_status = 'unfulfilled' WHERE id = $1`, [o.id]);
    await c.query(`UPDATE marketplace_orders SET payout_hold = true WHERE id = $1`, [o.id]);
    await c.query(`UPDATE marketplace_orders SET fulfillment_status = 'picked_up' WHERE id = $1`, [o.id]);
    await mustFail('payout eligible while on hold', 'UPDATE marketplace_orders SET payout_eligible = true WHERE id = $1', [o.id]);
    await c.query('ROLLBACK');

    const afterOrders = Number((await c.query('SELECT count(*)::int n FROM marketplace_orders')).rows[0].n);
    const afterItems = await itemsHash();
    results['nothing kept: order count unchanged'] = afterOrders === beforeOrders ? 'ok' : 'FAILED';
    results['nothing kept: items unchanged'] = afterItems === beforeItems ? 'ok' : 'FAILED';
    console.log(JSON.stringify(results, null, 2));
    const bad = Object.entries(results).filter(([, v]) => !String(v).startsWith('blocked') && v !== 'ok');
    console.log('RESULT: ' + (bad.length ? 'FAIL ' + bad.map(([k]) => k).join('; ') : 'PASS'));
    return bad.length ? 1 : 0;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('ERROR', e.message); return 1;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0));
