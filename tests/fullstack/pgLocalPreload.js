'use strict';

// Test-only preload for the isolated full-stack environment (node --require). The app always asks `pg` for SSL; the
// in-memory test database speaks plain TCP on 127.0.0.1. This removes `ssl` for local connections only, and refuses
// any connection that is not to 127.0.0.1, so a test app can never reach a real database.
const pg = require('pg');

function localOnly(config) {
  const c = typeof config === 'string' ? { connectionString: config } : Object.assign({}, config || {});
  let host = c.host;
  if (c.connectionString) { try { host = new URL(c.connectionString).hostname; } catch (_) { host = null; } }
  if (host !== '127.0.0.1') throw new Error('isolated test environment: refusing database host ' + host);
  delete c.ssl;
  return c;
}

const BasePool = pg.Pool;
const BaseClient = pg.Client;
class Pool extends BasePool { constructor(config) { super(localOnly(config)); } }
class Client extends BaseClient { constructor(config) { super(localOnly(config)); } }
pg.Pool = Pool;
pg.Client = Client;

// Transaction watch (2026-11-04). The in-memory test database runs every connection on ONE session: while a connection
// has a transaction open, only that connection is served. Code that, inside a transaction, waits for a query on another
// connection therefore stalls the whole database (a test's setup then times out). Any transaction left open longer than
// FULLSTACK_TX_WATCH_MS is reported with the place it began, on stderr and in FULLSTACK_TX_WATCH_FILE when set.
const fs = require('fs');
const WATCH_MS = Number(process.env.FULLSTACK_TX_WATCH_MS || 8000);
const open = new Map();   // client -> { at, stack }
const baseQuery = BaseClient.prototype.query;
BaseClient.prototype.query = function query(config, ...rest) {
  const text = typeof config === 'string' ? config : (config && config.text) || '';
  if (/^\s*BEGIN\b/i.test(text)) open.set(this, { at: Date.now(), stack: new Error('transaction began').stack.split('\n').slice(2, 14).join('\n'), reported: false });
  else if (/^\s*(COMMIT|ROLLBACK|END)\b/i.test(text)) open.delete(this);
  return baseQuery.call(this, config, ...rest);
};
setInterval(() => {
  for (const [, t] of open) {
    if (t.reported || Date.now() - t.at < WATCH_MS) continue;
    t.reported = true;
    const msg = `[tx-watch] a transaction has been open ${Math.round((Date.now() - t.at) / 1000)}s; it began at:\n${t.stack}\n`;
    process.stderr.write(msg);
    if (process.env.FULLSTACK_TX_WATCH_FILE) { try { fs.appendFileSync(process.env.FULLSTACK_TX_WATCH_FILE, msg); } catch (_) { /* best effort */ } }
  }
}, 1000).unref();
