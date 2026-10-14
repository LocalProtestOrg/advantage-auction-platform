'use strict';

/**
 * Production incident 2026-10-14: the tool guard wrapped client.query on pooled clients with a 2-argument function.
 * pg-pool's own pool.query calls client.query(text, values, callback) on those same clients, so the callback was dropped:
 * the query never resolved and the client never returned to the pool. A phone call's first turn completed, then every
 * later database call that landed on that client hung, so follow-up questions never reached Sasha.
 *
 * This test uses the REAL pg-pool with a one-connection pool (so the borrowed client is always reused) and an in-memory
 * client that supports both promise and callback forms, exactly like pg.Client. No network, no database, no model.
 */

const EventEmitter = require('events');
const Pool = require('pg-pool');
const guard = require('../../src/services/sasha/toolGuard');

class MemClient extends EventEmitter {
  connect(cb) { if (cb) { setImmediate(cb); return undefined; } return Promise.resolve(); }
  query(text, values, cb) {
    if (typeof values === 'function') { cb = values; values = undefined; }
    const res = { rows: [{ ok: 1 }], rowCount: 1 };
    if (cb) { setImmediate(() => cb(null, res)); return undefined; }
    return Promise.resolve(res);
  }
  end(cb) { if (cb) { setImmediate(cb); return undefined; } return Promise.resolve(); }
}

const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`HUNG: ${what} did not finish in ${ms} ms`)), ms))]);

function guardedDb() {
  const pool = new Pool({ Client: MemClient, max: 1 });
  const db = { query: (text, params) => pool.query(text, params), connect: () => pool.connect(), pool };
  guard.installDb(db);
  return db;
}

describe('tool guard never breaks pg-pool (regression: follow-up phone turns hung)', () => {
  test('pool.query keeps working after a client was borrowed with connect() and released (same client reused)', async () => {
    const db = guardedDb();
    for (let turn = 1; turn <= 5; turn++) {   // like several phone turns: a transaction on a borrowed client, then plain queries
      const c = await within(db.connect(), 1000, `connect (turn ${turn})`);
      await within(c.query('BEGIN'), 1000, 'BEGIN'); await within(c.query('SELECT 1 FOR UPDATE'), 1000, 'select'); await within(c.query('COMMIT'), 1000, 'COMMIT');
      c.release();
      const r = await within(db.query('UPDATE cs_ai_runs SET reply_message_id = $2 WHERE id = $1', ['a', 'b']), 1000, `pool.query after borrow (turn ${turn})`);
      expect(r.rows[0].ok).toBe(1);
    }
    await db.pool.end();
  });
  test('callback-style queries on a borrowed client get their callback (the form pg-pool uses internally)', async () => {
    const db = guardedDb();
    const c = await db.connect();
    const res = await within(new Promise((resolve, reject) => c.query('SELECT 1', [], (err, r) => (err ? reject(err) : resolve(r)))), 1000, 'callback query');
    expect(res.rowCount).toBe(1);
    c.release(); await db.pool.end();
  });
  test('inside a Sasha tool a forbidden write is still refused, through the callback when one is given', async () => {
    const db = guardedDb();
    const c = await db.connect();
    const err = await guard.run('send_payment_link', () => new Promise((resolve) => c.query('UPDATE buyer_auction_invoices SET total_cents = 0', [], (e) => resolve(e))));
    expect(err).toBeInstanceOf(guard.SashaToolPermissionError);
    await expect(guard.run('send_payment_link', () => db.query('DELETE FROM bids'))).rejects.toBeInstanceOf(guard.SashaToolPermissionError);
    c.release(); await db.pool.end();
  });
});
