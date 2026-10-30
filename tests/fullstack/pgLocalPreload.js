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
