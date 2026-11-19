'use strict';

/**
 * taxWorker - sales tax bookkeeping on a schedule (migration 231). It RECORDS and ALERTS only: it never registers with a
 * state, files a return, pays tax or moves money.
 *
 *   every 15 minutes   taxLedgerService.sync()            bring the tax ledger up to date with payments, orders, refunds
 *   once a day         taxFilingService.ensureCurrentFilings()   open the filing row for each period that just closed
 *   (and shortly       taxFilingService.deadlineAlerts()         filings due soon, overdue, or with no due date entered
 *    after start)      taxNexusService.alerts()                  states at or near a recorded economic nexus threshold
 *                      taxReconciliationService.run()            compare the ledger with its sources
 *
 * Every step is idempotent and isolated: one failing step is logged and the others still run; nothing is ever thrown.
 * A Postgres advisory lock makes a pass single-flight, so two instances never run the same pass at once (a second
 * instance simply skips). Active in production, or anywhere with TAX_WORKER_ENABLED=true; TAX_WORKER_DISABLED=true turns
 * it off.
 */

require('dotenv').config();

const TICK_MS = 15 * 60 * 1000;
const START_DELAY_MS = 2 * 60 * 1000;
// Advisory lock for the tax worker. TRANSACTION-scoped on purpose (incident 2026-11-19): production reaches the database
// through a transaction-mode pooler, where a SESSION advisory lock is taken on one shared server connection and the
// unlock can land on another, so the lock was never released and every later pass skipped silently (the first live
// refund was not posted to the ledger). A transaction-scoped lock is held by the one server connection the pooler pins
// for the transaction and is released by the database when the transaction ends, whatever happens to this process.
// The key differs from the first one (231116) so a lock still stranded on a pooled connection cannot block the fix.
const LOCK_KEY = 2311162;

function enabled(env = process.env) {
  if (String(env.TAX_WORKER_DISABLED || '').toLowerCase() === 'true') return false;
  return env.NODE_ENV === 'production' || String(env.TAX_WORKER_ENABLED || '').toLowerCase() === 'true';
}

const nyDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function step(name, fn, results) {
  try { results[name] = { ok: true, result: await fn() }; }
  catch (e) { results[name] = { ok: false, error: e && e.message }; console.error('[tax-worker] ' + name + ' failed:', e && e.message); }
}

let busy = false;
let lastDaily = null;   // America/New_York date of the last completed daily pass in this process

/** One pass. `daily` forces (true) or suppresses (false) the daily steps; by default they run once per New York day. */
async function tick({ now = new Date(), daily = null, force = false, deps = {} } = {}) {
  const results = {};
  if ((!force && !enabled()) || busy) return { skipped: busy ? 'busy' : 'disabled' };
  busy = true;
  let client = null;
  try {
    const db = deps.db || require('../db');
    client = await db.connect();
    await client.query('BEGIN');
    const got = (await client.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!got) { console.log('[tax-worker] pass skipped: another pass holds the lock'); return { skipped: 'locked' }; }
    try {
      const ledger = deps.ledger || require('../services/tax/taxLedgerService');
      await step('ledger_sync', () => ledger.sync(), results);
      const today = nyDate(now);
      const runDaily = daily == null ? lastDaily !== today : daily;
      if (runDaily) {
        const filings = deps.filings || require('../services/tax/taxFilingService');
        const nexus = deps.nexus || require('../services/tax/taxNexusService');
        await step('ensure_filings', () => filings.ensureCurrentFilings({ now }), results);
        await step('deadline_alerts', () => filings.deadlineAlerts({ now }), results);
        await step('nexus_alerts', () => nexus.alerts({ now }), results);
        await step('reconciliation', async () => {
          const run = await (deps.reconciliation || require('../services/tax/taxReconciliationService')).run({});
          return run ? { id: run.id, status: run.status } : null;
        }, results);
        lastDaily = today;
      }
      const posted = results.ledger_sync && results.ledger_sync.ok && results.ledger_sync.result ? results.ledger_sync.result.posted : null;
      if (posted || runDaily) console.log('[tax-worker] pass complete: ledger entries posted ' + (posted == null ? 'n/a' : posted) + (runDaily ? '; daily steps ' +
        ['ensure_filings', 'deadline_alerts', 'nexus_alerts', 'reconciliation'].map((k) => k + '=' + (results[k] && results[k].ok ? 'ok' : 'failed')).join(' ') : ''));
    } finally { /* the lock is released when the transaction ends, below */ }
    return results;
  } catch (e) {
    console.error('[tax-worker] pass failed:', e && e.message);
    return { ...results, error: e && e.message };
  } finally {
    if (client) {
      await client.query('COMMIT').catch(() => {});   // ends the lock transaction (it holds only the lock); releases the lock
      try { client.release(); } catch (_) { /* already released */ }
    }
    busy = false;
  }
}

if (require.main === module) {
  console.log(enabled()
    ? '[tax-worker] scheduler active: ledger sync every 15 minutes; filings, alerts and reconciliation once a day'
    : '[tax-worker] scheduler idle: disabled (production only, or TAX_WORKER_ENABLED=true; TAX_WORKER_DISABLED=true turns it off); worker stays alive, no runs');
  setTimeout(() => { tick(); }, START_DELAY_MS);   // after startup, so the server is answering
  setInterval(() => { tick(); }, TICK_MS);
}

module.exports = { tick, enabled, LOCK_KEY };
