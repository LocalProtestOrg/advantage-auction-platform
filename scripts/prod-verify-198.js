#!/usr/bin/env node
/* prod-verify-198.js — PRODUCTION verification of migration 198 (listing moderation + buyer reports), with NOTHING kept.
   One transaction on the direct endpoint that always ends in ROLLBACK: on the demo storefront item it records a temporary
   report and a temporary takedown, then attempts every prohibited change (each in a savepoint). Afterwards it confirms
   (outside the transaction) that items, reports and moderation history are exactly as before. Prints verdicts only.
   Usage: railway run node scripts/prod-verify-198.js */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });   // never the pooler
  await c.connect();
  const results = {};
  const state = async () => (await c.query(`SELECT md5(coalesce((SELECT string_agg(id::text||':'||seller_id::text||':'||status||':'||moderation_status, ',' ORDER BY id) FROM marketplace_items),'')
    || (SELECT count(*) FROM marketplace_item_reports)::text || (SELECT count(*) FROM marketplace_item_moderation_events)::text) h`)).rows[0].h;
  try {
    const before = await state();
    await c.query('BEGIN');
    await c.query(`SET LOCAL statement_timeout = '15s'`);
    const item = (await c.query(`SELECT mi.id, mi.seller_id, mi.status FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE sp.is_demo = true AND mi.status = 'active' ORDER BY mi.created_at LIMIT 1`)).rows[0];
    const other = (await c.query('SELECT id FROM seller_profiles WHERE id <> $1 ORDER BY created_at LIMIT 1', [item.seller_id])).rows[0];
    const buyer = (await c.query(`SELECT id FROM users WHERE lower(email) = 'validation-buyer@advantage.bid'`)).rows[0];
    const admin = (await c.query(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`)).rows[0];
    if (!item || !other || !buyer || !admin) throw new Error('fixtures missing');
    const mustFail = async (name, sql, p) => {
      await c.query('SAVEPOINT t');
      try { await c.query(sql, p); results[name] = 'NOT BLOCKED'; }
      catch (e) { results[name] = (['23514', '23503', '23505'].includes(e.code) ? 'blocked ' : 'UNEXPECTED ') + e.code + ': ' + String(e.message).slice(0, 70); }
      await c.query('ROLLBACK TO SAVEPOINT t');
    };
    const insReport = `INSERT INTO marketplace_item_reports (item_id, seller_id, reporter_user_id, category, message) VALUES ($1,$2,$3,'other','verify rollback') RETURNING id`;
    await mustFail('report naming another seller', insReport, [item.id, other.id, buyer.id]);
    const rep = (await c.query(insReport, [item.id, item.seller_id, buyer.id])).rows[0];
    results['valid report accepted'] = rep ? 'ok' : 'FAILED';
    await mustFail('second open report by same person', insReport, [item.id, item.seller_id, buyer.id]);
    await mustFail('edit report words', `UPDATE marketplace_item_reports SET message = 'changed' WHERE id = $1`, [rep.id]);
    await mustFail('move report to another seller', 'UPDATE marketplace_item_reports SET seller_id = $2 WHERE id = $1', [rep.id, other.id]);
    await mustFail('delete report', 'DELETE FROM marketplace_item_reports WHERE id = $1', [rep.id]);
    await c.query(`UPDATE marketplace_item_reports SET status = 'dismissed', review_note = 'verify', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [rep.id, admin.id]);
    await mustFail('reopen a reviewed report', `UPDATE marketplace_item_reports SET status = 'open' WHERE id = $1`, [rep.id]);

    await c.query(`UPDATE marketplace_items SET status = 'removed', moderation_status = 'taken_down', moderation_reason = 'verify rollback' WHERE id = $1`, [item.id]);
    results['takedown recorded'] = 'ok';
    await mustFail('taken-down listing set live', `UPDATE marketplace_items SET status = 'active' WHERE id = $1`, [item.id]);
    await mustFail('taken-down listing set in checkout', `UPDATE marketplace_items SET status = 'pending_purchase' WHERE id = $1`, [item.id]);
    await c.query(`INSERT INTO marketplace_item_moderation_events (item_id, seller_id, action, actor_user_id, reason, prior_status) VALUES ($1,$2,'takedown',$3,'verify rollback',$4)`,
      [item.id, item.seller_id, admin.id, item.status]);
    await mustFail('moderation history naming another seller', `INSERT INTO marketplace_item_moderation_events (item_id, seller_id, action, actor_user_id, reason) VALUES ($1,$2,'takedown',$3,'wrong seller')`,
      [item.id, other.id, admin.id]);
    await mustFail('moderation history without a reason', `INSERT INTO marketplace_item_moderation_events (item_id, seller_id, action, actor_user_id, reason) VALUES ($1,$2,'takedown',$3,'x')`,
      [item.id, item.seller_id, admin.id]);
    await mustFail('rewrite moderation history', `UPDATE marketplace_item_moderation_events SET reason = 'edited' WHERE item_id = $1`, [item.id]);
    await mustFail('delete moderation history', 'DELETE FROM marketplace_item_moderation_events WHERE item_id = $1', [item.id]);
    await mustFail('reported listing changes owner', 'UPDATE marketplace_items SET seller_id = $2 WHERE id = $1', [item.id, other.id]);
    await c.query('ROLLBACK');

    results['nothing kept (items, reports, history unchanged)'] = (await state()) === before ? 'ok' : 'FAILED';
    console.log(JSON.stringify(results, null, 2));
    const bad = Object.entries(results).filter(([, v]) => !String(v).startsWith('blocked') && v !== 'ok');
    console.log('RESULT: ' + (bad.length ? 'FAIL ' + bad.map(([k]) => k).join('; ') : 'PASS'));
    return bad.length ? 1 : 0;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('ERROR', e.message); return 1;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0));
