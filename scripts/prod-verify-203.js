#!/usr/bin/env node
/* prod-verify-203.js — PRODUCTION verification of migration 203 with NOTHING kept: one transaction that always ends in
   ROLLBACK. On the demo storefront it creates a draft policy, publishes it, then attempts every prohibited change (each in
   a savepoint). Afterwards it confirms (outside the transaction) that no policy rows exist. Prints verdicts only.
   Usage: railway run node scripts/prod-verify-203.js */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const results = {};
  const count = async () => Number((await c.query('SELECT count(*)::int n FROM seller_policy_versions')).rows[0].n);
  try {
    const before = await count();
    await c.query('BEGIN'); await c.query(`SET LOCAL statement_timeout = '15s'`);
    const sp = (await c.query(`SELECT id, user_id FROM seller_profiles WHERE is_demo = true AND storefront_slug IS NOT NULL ORDER BY created_at LIMIT 1`)).rows[0];
    const other = (await c.query('SELECT id FROM seller_profiles WHERE id <> $1 ORDER BY created_at LIMIT 1', [sp.id])).rows[0];
    const mustFail = async (name, sql, p) => {
      await c.query('SAVEPOINT t');
      try { await c.query(sql, p); results[name] = 'NOT BLOCKED'; }
      catch (e) { results[name] = (['23514', '23505', '23503'].includes(e.code) ? 'blocked ' : 'UNEXPECTED ') + e.code; }
      await c.query('ROLLBACK TO SAVEPOINT t');
    };
    await mustFail('insert as already published', `INSERT INTO seller_policy_versions (seller_id, kind, version, status, body, content_hash, created_by) VALUES ($1,'store_terms',1,'published','x','h',$2)`, [sp.id, sp.user_id]);
    const v = (await c.query(`INSERT INTO seller_policy_versions (seller_id, kind, version, body, content_hash, created_by) VALUES ($1,'store_terms',1,'verify rollback terms','h1',$2) RETURNING id`, [sp.id, sp.user_id])).rows[0];
    results['draft created'] = 'ok';
    await mustFail('second draft of the same kind', `INSERT INTO seller_policy_versions (seller_id, kind, version, body, content_hash, created_by) VALUES ($1,'store_terms',2,'x','h2',$2)`, [sp.id, sp.user_id]);
    await c.query(`UPDATE seller_policy_versions SET status = 'published', published_at = now(), published_by = $2 WHERE id = $1`, [v.id, sp.user_id]);
    results['published'] = 'ok';
    await mustFail('rewrite published words', `UPDATE seller_policy_versions SET body = 'changed' WHERE id = $1`, [v.id]);
    await mustFail('move to another seller', `UPDATE seller_policy_versions SET seller_id = $2 WHERE id = $1`, [v.id, other.id]);
    await mustFail('back to draft', `UPDATE seller_policy_versions SET status = 'draft' WHERE id = $1`, [v.id]);
    await mustFail('delete a version', `DELETE FROM seller_policy_versions WHERE id = $1`, [v.id]);
    await mustFail('withdraw without a reason', `UPDATE seller_policy_versions SET status = 'withdrawn' WHERE id = $1`, [v.id]);
    await c.query('ROLLBACK');
    results['nothing kept'] = (await count()) === before ? 'ok' : 'FAILED';
    console.log(JSON.stringify(results, null, 2));
    const bad = Object.entries(results).filter(([, x]) => !String(x).startsWith('blocked') && x !== 'ok');
    console.log('RESULT: ' + (bad.length ? 'FAIL ' + bad.map(([k]) => k).join('; ') : 'PASS'));
    return bad.length ? 1 : 0;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('ERROR', e.message); return 1; }
  finally { await c.end(); }
})().then((code) => process.exit(code || 0));
