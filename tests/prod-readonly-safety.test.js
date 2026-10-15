'use strict';

/**
 * Incident 2026-10-14: investigation scripts ran SET SESSION ... READ ONLY over the pooled production URL; the setting
 * stuck to shared pgbouncer server connections and the live app's background jobs failed. These checks keep read-only
 * investigations transaction-scoped and on the direct endpoint. No database is used.
 */

const fs = require('fs');
const path = require('path');
const { withProdReadOnly, directUrl } = require('../scripts/lib/prodReadOnly');

const ROOT = path.join(__dirname, '..');

class RecClient {
  constructor(opts) { RecClient.last = this; this.opts = opts; this.sql = []; }
  async connect() {}
  async query(sql) { this.sql.push(String(sql)); return { rows: [{ ok: 1 }] }; }
  async end() { this.ended = true; }
}

describe('prodReadOnly helper', () => {
  test('uses the direct endpoint, a READ ONLY transaction, SET LOCAL only, and always rolls back', async () => {
    const rows = await withProdReadOnly(async (q) => q('SELECT 1'), { url: 'postgresql://u:p@ep-x-pooler.example/db', Client: RecClient });
    expect(rows).toEqual([{ ok: 1 }]);
    const c = RecClient.last;
    expect(c.opts.connectionString).toBe('postgresql://u:p@ep-x.example/db');
    expect(c.sql[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(c.sql[1]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(c.sql[c.sql.length - 1]).toBe('ROLLBACK');
    expect(c.sql.some((s) => /SET SESSION|default_transaction_read_only/i.test(s))).toBe(false);
    expect(c.ended).toBe(true);
  });
  test('refuses session changes, transaction control and writes (and still rolls back)', async () => {
    for (const bad of ['SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', 'set default_transaction_read_only = on', 'COMMIT', 'UPDATE auctions SET title = 1', 'DISCARD ALL', 'RESET ALL']) {
      await expect(withProdReadOnly(async (q) => q(bad), { url: 'postgresql://x-pooler/db', Client: RecClient })).rejects.toThrow(/only read queries/);
      expect(RecClient.last.sql[RecClient.last.sql.length - 1]).toBe('ROLLBACK');
    }
    expect(directUrl('postgresql://a@ep-1-pooler.neon.tech/db')).toBe('postgresql://a@ep-1.neon.tech/db');
  });
});

describe('repository guard: nothing sets session state over the pooled production URL', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/node_modules|reports|\.git/.test(e.name)) walk(p); } else if (/\.js$/.test(e.name)) files.push(p); } };
  for (const d of ['scripts', 'certification', 'src']) walk(path.join(ROOT, d));
  test('every SET SESSION / default_transaction_read_only use is on a direct (non-pooler) connection', () => {
    const offenders = files.filter((f) => {
      const s = fs.readFileSync(f, 'utf8');
      if (!/SET\s+SESSION\b|default_transaction_read_only\s*=/i.test(s)) return false;   // \b: not the users.session_version column
      if (/scripts[\\/]lib[\\/]prodReadOnly\.js$/.test(f)) return false;   // the helper only names them to refuse them
      return !/replace\(\s*'-pooler'\s*,\s*''\s*\)/.test(s);
    }).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
