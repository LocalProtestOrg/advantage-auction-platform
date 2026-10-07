'use strict';

/* Worker thread hosting PGlite (outside Jest's VM, where its WASM loader can use dynamic import). Messages:
   { id, op: 'exec', sql } | { id, op: 'query', sql, params }  →  { id, rows, affectedRows } | { id, error } */
const { parentPort } = require('worker_threads');
const { PGlite } = require('@electric-sql/pglite');

const db = new PGlite();
parentPort.on('message', async (m) => {
  try {
    if (m.op === 'exec') { await db.exec(m.sql); parentPort.postMessage({ id: m.id, rows: [], affectedRows: 0 }); return; }
    const r = await db.query(m.sql, m.params || []);
    parentPort.postMessage({ id: m.id, rows: r.rows, affectedRows: r.affectedRows });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: e.message, code: e.code || null });
  }
});
