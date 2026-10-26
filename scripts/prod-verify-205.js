#!/usr/bin/env node
/* prod-verify-205.js — PRODUCTION verification of migration 205 (item messaging) with NOTHING kept and NO email or alert
   sent: one transaction that always ends in ROLLBACK (uncommitted rows are invisible to the live notification sender).
   On a demo storefront item it opens a conversation for the validation buyer and runs the REAL production message code
   (storefrontMessagingService.insertMessage — screening, limits, outbox) for a masked message and a held message, then
   attempts every prohibited change. Afterwards it confirms nothing was kept. Prints verdicts only (no message text).
   Messaging stays OFF; this script does not need or change the flag.
   Usage: railway run node scripts/prod-verify-205.js */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const messaging = require('../src/services/storefrontMessagingService');
  const notify = require('../src/services/storefrontNotificationService');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const results = {};
  const state = async () => (await c.query(`SELECT (SELECT count(*) FROM storefront_conversations)::text || ':' || (SELECT count(*) FROM storefront_messages)::text
    || ':' || (SELECT count(*) FROM storefront_message_reviews)::text || ':' || (SELECT count(*) FROM storefront_conversation_access_log)::text
    || ':' || (SELECT count(*) FROM storefront_notifications)::text s`)).rows[0].s;
  try {
    const before = await state();
    await c.query('BEGIN'); await c.query(`SET LOCAL statement_timeout = '15s'`);
    const item = (await c.query(`SELECT mi.* FROM marketplace_items mi WHERE mi.is_demo AND mi.status = 'active' ORDER BY mi.created_at LIMIT 1`)).rows[0];
    const buyer = (await c.query(`SELECT id, email FROM users WHERE lower(email) = 'validation-buyer@advantage.bid'`)).rows[0];
    const owner = (await c.query('SELECT sp.user_id, u.email FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1', [item.seller_id])).rows[0];
    const other = (await c.query('SELECT id, user_id FROM seller_profiles WHERE id <> $1 AND user_id IS NOT NULL ORDER BY created_at LIMIT 1', [item.seller_id])).rows[0];
    const mustFail = async (name, sql, p) => {
      await c.query('SAVEPOINT t');
      try { await c.query(sql, p); results[name] = 'NOT BLOCKED'; }
      catch (e) { results[name] = (['23514', '23505', '23503'].includes(e.code) ? 'blocked ' : 'UNEXPECTED ') + e.code; }
      await c.query('ROLLBACK TO SAVEPOINT t');
    };
    const conv = (await c.query(`INSERT INTO storefront_conversations (seller_id, item_id, buyer_user_id, subject_snapshot) VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
      [item.seller_id, item.id, buyer.id, JSON.stringify({ title: item.title, inventory_number: item.inventory_number || null })])).rows[0];
    results['conversation is demo because the item is demo'] = conv.is_demo === true ? 'ok' : 'FAILED';
    await mustFail('conversation naming another seller for this item', `INSERT INTO storefront_conversations (seller_id, item_id, buyer_user_id) VALUES ($1, $2, $3)`,
      [other.id, item.id, other.user_id]);
    await mustFail('seller opening a conversation with their own company', `INSERT INTO storefront_conversations (seller_id, item_id, buyer_user_id) VALUES ($1, $2, $3)`,
      [item.seller_id, item.id, owner.user_id]);

    const masked = await messaging.insertMessage(c, conv, 'buyer', buyer.id, 'Is it solid walnut? My cell 713 555 0199', null);
    results['contact details hidden, message delivered'] = masked.message.status === 'delivered' && !/0199/.test(masked.message.delivered_body) ? 'ok' : 'FAILED';
    const notice = (await c.query('SELECT * FROM storefront_notifications WHERE message_id = $1', [masked.message.id])).rows;
    results['one notice queued for the item\'s own seller'] = notice.length === 1 && notice[0].event === 'message_to_seller' && notice[0].seller_id === item.seller_id
      && notice[0].recipient_email === String(owner.email).toLowerCase() && notice[0].is_demo === true ? 'ok' : 'FAILED';
    const held = await messaging.insertMessage(c, conv, 'buyer', buyer.id, 'Can I Venmo you and skip the fee?', null);
    results['payment-off-platform message held, no notice'] = held.message.status === 'held'
      && Number((await c.query('SELECT count(*)::int n FROM storefront_notifications WHERE message_id = $1', [held.message.id])).rows[0].n) === 0 ? 'ok' : 'FAILED';
    const dup = await messaging.insertMessage(c, conv, 'buyer', buyer.id, 'Is it solid walnut? My cell 713 555 0199', null);
    results['repeated message returns the earlier one'] = dup.duplicate && dup.message.id === masked.message.id ? 'ok' : 'FAILED';

    await mustFail('message written as the buyer by someone else', `INSERT INTO storefront_messages (conversation_id, seller_id, sender_role, sender_user_id, body, delivered_body, status, delivered_at)
      VALUES ($1, $2, 'buyer', $3, 'x', 'x', 'delivered', now())`, [conv.id, item.seller_id, other.user_id]);
    await mustFail('message written as the seller by another company', `INSERT INTO storefront_messages (conversation_id, seller_id, sender_role, sender_user_id, body, delivered_body, status, delivered_at)
      VALUES ($1, $2, 'seller', $3, 'x', 'x', 'delivered', now())`, [conv.id, item.seller_id, other.user_id]);
    await mustFail('message filed under another seller', `INSERT INTO storefront_messages (conversation_id, seller_id, sender_role, sender_user_id, body, delivered_body, status, delivered_at)
      VALUES ($1, $2, 'buyer', $3, 'x', 'x', 'delivered', now())`, [conv.id, other.id, buyer.id]);
    await mustFail('rewrite what the sender wrote', `UPDATE storefront_messages SET body = 'changed' WHERE id = $1`, [masked.message.id]);
    await mustFail('rewrite the delivered text', `UPDATE storefront_messages SET delivered_body = 'changed' WHERE id = $1`, [masked.message.id]);
    await mustFail('put a delivered message back on hold', `UPDATE storefront_messages SET status = 'held', delivered_body = NULL, delivered_at = NULL WHERE id = $1`, [masked.message.id]);
    await mustFail('change the conversation buyer', `UPDATE storefront_conversations SET buyer_user_id = $2 WHERE id = $1`, [conv.id, other.user_id]);
    await mustFail('notice for another seller\'s message', `INSERT INTO storefront_notifications (seller_id, message_id, event, recipient_email) VALUES ($1, $2, 'message_to_seller', 'x@example.com')`,
      [other.id, masked.message.id]);
    await mustFail('sale notice without an order', `INSERT INTO storefront_notifications (seller_id, message_id, event, recipient_email) VALUES ($1, $2, 'sale_paid', 'x@example.com')`,
      [item.seller_id, masked.message.id]);
    await c.query(`INSERT INTO storefront_message_reviews (message_id, seller_id, action, actor_user_id, note) VALUES ($1, $2, 'withdrawn', $3, NULL)`, [held.message.id, item.seller_id, buyer.id]);
    await mustFail('rewrite review history', `UPDATE storefront_message_reviews SET note = 'changed' WHERE message_id = $1`, [held.message.id]);

    const m = (await c.query(`SELECT m.id, m.conversation_id, m.delivered_body, c.subject_snapshot, sp.show_branding_to_buyers,
      COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
      FROM storefront_messages m JOIN storefront_conversations c ON c.id = m.conversation_id JOIN seller_profiles sp ON sp.id = c.seller_id WHERE m.id = $1`, [masked.message.id])).rows[0];
    const email = notify.renderMessageNotice({ ...m, event: 'message_to_seller' });
    const all = email.subject + email.html + email.text;
    const addresses = (all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter((x) => x.toLowerCase() !== 'info@advantage.bid');
    results['seller email: item, hidden details, reply link; no buyer data'] = all.includes(item.title) && all.includes('[phone number hidden]')
      && all.includes('/seller-messages.html?c=') && !addresses.length && !/0199|validation-buyer/i.test(all) ? 'ok' : 'FAILED';

    await c.query('ROLLBACK');
    results['nothing kept (no conversation, message, review, log or notice committed; no email sent)'] = (await state()) === before ? 'ok' : 'FAILED';
    console.log(JSON.stringify(results, null, 2));
    const bad = Object.entries(results).filter(([, x]) => !String(x).startsWith('blocked') && x !== 'ok');
    console.log('RESULT: ' + (bad.length ? 'FAIL ' + bad.map(([k]) => k).join('; ') : 'PASS'));
    return bad.length ? 1 : 0;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('ERROR', e.message); return 1; }
  finally { await c.end(); }
})().then((code) => process.exit(code || 0));
