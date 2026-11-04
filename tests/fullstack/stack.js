'use strict';

/**
 * Isolated full-stack environment: the REAL app (server.js) on the REAL schema (every migration, see schema.mjs),
 * backed by an in-memory PGlite database. Nothing here can reach a real database, payment processor, email
 * provider or image host:
 *   - the app runs with a CLEAN environment (no inherited variables) and a working directory without a .env file,
 *     so dotenv loads nothing and no real credential is ever present;
 *   - background workers are off (AAP_IS_WORKER=1);
 *   - the database exists only in the child process's memory and disappears when it stops.
 *
 * Used by browser tests (Chromium via Playwright) and by the watchdog's state-changing journeys, which must never
 * run against production.
 *
 *   const stack = await startStack();      // { baseUrl, query(sql, params), stop() }
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..', '..');
const TEST_JWT_SECRET = 'fullstack-test-secret-not-a-real-credential';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function waitForLine(child, re, ms, label) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${label} did not start within ${ms} ms:\n${buf.slice(-2000)}`)), ms);
    const on = (d) => { buf += d.toString(); const m = buf.match(re); if (m) { clearTimeout(timer); resolve(m); } };
    child.stdout.on('data', on);
    child.stderr.on('data', (d) => { buf += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${label} exited (${code}):\n${buf.slice(-2000)}`)); });
  });
}

async function waitForHttp(url, ms) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    // each attempt is time-limited: an app that accepted the connection but never answers must not wait forever
    try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.status < 500) return; last = 'HTTP ' + r.status; } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`app did not answer ${url}: ${last}`);
}

/** Minimal, credential-free environment for the app child. */
function cleanEnv(extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'FULLSTACK_TX_WATCH_MS', 'FULLSTACK_TX_WATCH_FILE'];
  const env = {};
  for (const k of keep) if (process.env[k] != null) env[k] = process.env[k];
  return Object.assign(env, extra);
}

// fakeStorage: replace photo storage with an in-memory stand-in (fakeStoragePreload.js) for photo workflows.
// fakePayments: replace the payment processor's library with an in-memory stand-in (fakeStripePreload.js) and turn
// marketplace checkout on, so purchases can be tested end to end without any network or keys.
// The in-memory database occasionally stalls while the app boots (one connection holds a transaction; on the CI runner
// about one start in ten). A start that does not answer within 45s is reported with the app's log (including any
// transaction-watch report from pgLocalPreload.js) and made once more from scratch.
async function startStack(opts = {}) {
  try { return await startOnce(opts); } catch (e) {
    process.stderr.write(`[fullstack] start failed, starting again from scratch: ${String(e.message).slice(0, 4000)}\n`);
    return startOnce(opts);
  }
}

async function startOnce({ env = {}, quiet = true, fakeStorage = false, fakePayments = false } = {}) {
  // On CI each startup stage's time is printed, so a stalled setup shows where it stalled.
  const t0 = Date.now(); const stage = (s) => { if (process.env.CI) process.stderr.write(`[fullstack] ${s} after ${((Date.now() - t0) / 1000).toFixed(1)}s\n`); };
  const dbPort = await freePort();
  const appPort = await freePort();
  const db = spawn(process.execPath, [path.join(__dirname, 'dbServer.mjs'), String(dbPort)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForLine(db, /READY (\d+) (\d+)/, 120000, 'isolated database');
  stage('isolated database ready');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aap-fullstack-'));   // no .env here: dotenv loads nothing
  const appEnv = cleanEnv(Object.assign({
    NODE_ENV: 'test',
    PORT: String(appPort),
    AAP_IS_WORKER: '1',
    DATABASE_URL: `postgres://postgres@127.0.0.1:${dbPort}/postgres`,
    JWT_SECRET: TEST_JWT_SECRET,
    PUBLIC_BASE_URL: `http://127.0.0.1:${appPort}`,
    FRONTEND_URL: `http://127.0.0.1:${appPort}`,
    ANALYTICS_TAG_ENABLED: 'false',
    ...(fakePayments ? { STRIPE_SECRET_KEY: 'sk_test_isolated_placeholder', STRIPE_PUBLISHABLE_KEY: 'pk_test_isolated_placeholder', MARKETPLACE_CHECKOUT_ENABLED: 'true' } : {}),
  }, env));
  const preloads = ['pgLocalPreload.js', ...(fakeStorage ? ['fakeStoragePreload.js'] : []), ...(fakePayments ? ['fakeStripePreload.js'] : [])]
    .flatMap((f) => ['--require', path.join(__dirname, f)]);
  const app = spawn(process.execPath, [...preloads, path.join(ROOT, 'server.js')], { cwd: workDir, env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  const keepLog = (d) => { logs.push(d.toString()); if (logs.length > 400) logs.shift(); if (!quiet) process.stdout.write(d); };
  app.stdout.on('data', keepLog); app.stderr.on('data', keepLog);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  try { await waitForHttp(baseUrl + '/api/health', 45000); } catch (e) { app.kill(); db.kill(); throw new Error(e.message + '\n' + logs.join('').slice(-3000)); }
  stage('app answering');

  const { Pool } = require('pg');
  const pool = new Pool({ host: '127.0.0.1', port: dbPort, user: 'postgres', database: 'postgres', max: 2 });
  const query = (sql, params) => pool.query(sql, params);

  const exited = (p) => new Promise((resolve) => { if (p.exitCode != null || p.signalCode != null) return resolve(); p.once('exit', () => resolve()); });
  async function stop() {
    try { await pool.end(); } catch (_) {}
    for (const p of [app, db]) { try { p.kill(); } catch (_) {} }
    await Promise.race([Promise.all([exited(app), exited(db)]), new Promise((r) => setTimeout(r, 5000))]);
    for (const p of [app, db]) { for (const s of [p.stdout, p.stderr]) { try { s.destroy(); } catch (_) {} } }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
  return { baseUrl, dbPort, appPort, query, stop, logs: () => logs.join(''), jwtSecret: TEST_JWT_SECRET };
}

module.exports = { startStack, TEST_JWT_SECRET };
