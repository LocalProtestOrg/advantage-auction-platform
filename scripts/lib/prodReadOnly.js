'use strict';

/**
 * Safe read-only production queries for investigations (incident 2026-10-14).
 *
 * The production DATABASE_URL is Neon's "-pooler" endpoint (pgbouncer, TRANSACTION mode): many app clients share a few
 * server connections. Anything set at SESSION level on a pooled connection (SET SESSION CHARACTERISTICS ... READ ONLY,
 * SET default_transaction_read_only, SET search_path, ...) stays on that shared server connection after the script
 * disconnects, and the live app then inherits it. On 2026-10-14 two such connections were left read-only and background
 * jobs failed until the compute was restarted.
 *
 * This helper therefore:
 *   - connects to the DIRECT endpoint only (the "-pooler" host part is removed; a URL that is not a pooler URL is used
 *     as-is), so nothing it does can touch the app's pooled connections;
 *   - runs the caller's queries inside ONE transaction opened with BEGIN TRANSACTION READ ONLY (scoped to that
 *     transaction, never the session) and always ends it with ROLLBACK;
 *   - sets a short statement timeout with SET LOCAL (also transaction-scoped);
 *   - refuses any statement that would change session state or write.
 *
 * Usage:  const { withProdReadOnly } = require('./lib/prodReadOnly');
 *         await withProdReadOnly(async (q) => { const rows = await q('SELECT ...', [..]); ... });
 */

const SESSION_OR_WRITE = /^\s*(SET\s+(?!LOCAL\b)|RESET\b|DISCARD\b|BEGIN\b|START\s+TRANSACTION|COMMIT\b|END\b|ROLLBACK\b|INSERT\b|UPDATE\b|DELETE\b|TRUNCATE\b|ALTER\b|CREATE\b|DROP\b|GRANT\b|REVOKE\b|COPY\b|CALL\b|DO\b|VACUUM\b|LISTEN\b|NOTIFY\b|LOCK\b)/i;

function directUrl(url) {
  const raw = String(url || '');
  if (!raw) throw new Error('DATABASE_URL is not set.');
  return raw.replace('-pooler', '');
}

async function withProdReadOnly(fn, { url = process.env.DATABASE_URL, Client = require('pg').Client, statementTimeoutMs = 15000 } = {}) {
  const c = new Client({ connectionString: directUrl(url), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    await c.query(`SET LOCAL statement_timeout = ${Math.max(1000, Number(statementTimeoutMs) || 15000)}`);
    const q = async (sql, params = []) => {
      if (SESSION_OR_WRITE.test(String(sql))) throw new Error('prodReadOnly: only read queries are allowed (no SET, transaction control or writes).');
      return (await c.query(sql, params)).rows;
    };
    return await fn(q);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
}

module.exports = { withProdReadOnly, directUrl, SESSION_OR_WRITE };
