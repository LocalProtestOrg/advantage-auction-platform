'use strict';

/**
 * The isolated full-stack environment (tests/fullstack) must keep production's schema: every production column
 * (tests/fullstack/production-columns.txt, captured read-only from production's information_schema 2026-10-30) must
 * exist after applying every migration. A migration that production has but the files do not (or the reverse) shows
 * up here, so browser tests and watchdog journeys never run against a schema that has drifted from production.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');

jest.setTimeout(120000);

test('every production column exists in the isolated schema', async () => {
  const port = 55000 + Math.floor(Math.random() * 3000);
  const db = spawn(process.execPath, [path.join(__dirname, 'fullstack', 'dbServer.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { let b = ''; db.stdout.on('data', (d) => { b += d; if (/READY/.test(b)) resolve(); }); db.on('exit', (c) => reject(new Error('db exited ' + c))); setTimeout(() => reject(new Error('timeout')), 100000); });
    const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
    await c.connect();
    const have = new Set((await c.query(`SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'public'`)).rows.map((r) => r.k));
    await c.end();
    const prod = fs.readFileSync(path.join(__dirname, 'fullstack', 'production-columns.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
    expect(prod.length).toBeGreaterThan(3000);
    expect(prod.filter((k) => !have.has(k))).toEqual([]);
  } finally { db.kill(); }
});
