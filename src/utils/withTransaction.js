'use strict';

const db = require('../db');

/**
 * Run `fn(client)` inside a single DB transaction.
 * COMMITs on success, ROLLBACKs on any throw, always releases the client.
 * Mirrors the transaction pattern used in auctionService (BEGIN/COMMIT/ROLLBACK).
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withTransaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback error */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
