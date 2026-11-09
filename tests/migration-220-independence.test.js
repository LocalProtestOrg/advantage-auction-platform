'use strict';

/**
 * Migration 220 (account_verification_codes) ships in the storefront release WITHOUT auction shipping (migrations 218 and
 * 219, PR #86). Its production runner first required 219 (a leftover from PR #86's ordering) and refused the release
 * (2026-11-09). These checks keep 220 independent of 218/219 and the runner from requiring them again.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const SQL = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '220_account_verification_codes.sql'), 'utf8');
const RUNNER = fs.readFileSync(path.join(ROOT, 'scripts', 'prod-migrate-220.js'), 'utf8');

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}

test('220 references nothing but users (no auction-shipping table or column)', () => {
  const code = SQL.replace(/--[^\n]*/g, '');
  expect([...code.matchAll(/REFERENCES\s+(\w+)/gi)].map((m) => m[1])).toEqual(['users']);
  expect(code).not.toMatch(/auction_shipment|seller_shipping_profiles|shipping_eligible|delivered_at|lots\b/i);
});

test('220 applies on a database that has only users (218 and 219 never applied)', async () => {   // (a fresh database worker: allow for a loaded machine)
  const pg = startPg();
  try {
    await pg.exec('CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT);');
    await pg.exec(SQL);
    const r = await pg.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name IN ('account_verification_codes', 'auction_shipments', 'seller_shipping_profiles')`);
    expect(r.rows[0].n).toBe(1);   // only the new table; no shipping table came with it
    const u = await pg.query('INSERT INTO users (email) VALUES ($1) RETURNING id', ['x@test.example']);
    await pg.query(`INSERT INTO account_verification_codes (user_id, purpose, expires_at) VALUES ($1, 'payout_destination_change', now() + interval '10 minutes')`, [u.rows[0].id]);
  } finally { await pg.close(); }
}, 30000);

test('the production runner requires the baseline and the users table, never 218 or 219', () => {
  const ok = (RUNNER.match(/const ok = ([^;]+);/) || [])[1] || '';
  expect(ok).toMatch(/pre\.baseline_226_applied/);
  expect(ok).toMatch(/pre\.users_table_present/);
  expect(ok).not.toMatch(/218|219|info_/);
  expect(RUNNER).toMatch(/baseline_226_applied: await has\(`SELECT 1 AS x FROM schema_migrations WHERE filename = '226_remove_obsolete_pricing_config\.sql'`\)/);
});
