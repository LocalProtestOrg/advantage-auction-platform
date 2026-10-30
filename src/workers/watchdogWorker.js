'use strict';

/**
 * watchdogWorker — runs the non-destructive site watchdog checks on their risk-tier schedule (critical every 15
 * minutes, high hourly, normal every 6 hours; src/services/watchdog/registry.js) and alerts on new or re-opened
 * critical/high findings. Idle unless WATCHDOG_ENABLED=true. Checks only READ the public site (GET requests) and the
 * page files on disk; they never sign, bid, buy, write inventory or email anyone but the operations alert address.
 */
require('dotenv').config();

const db = require('../db');
const runner = require('../services/watchdog/runner');

const TICK_MS = 5 * 60 * 1000;
let busy = false;

async function tick() {
  if (!runner.enabled() || busy) return;
  busy = true;
  try {
    const out = await runner.runServerChecks({ db });
    if (out.ran) console.log('[watchdog] ran', out.ran, 'checks: failed', out.failed, 'skipped', out.skipped, 'opened', out.opened, 'reopened', out.reopened, 'resolved', out.resolved);
    const a = await runner.sendAlerts({ db });
    if (a.findings) console.log('[watchdog] alert', a.sent ? 'sent' : 'not sent (' + (a.reason || 'unknown') + ')', 'for', a.findings, 'finding(s)');
  } catch (e) { console.error('[watchdog] tick failed:', e.message); }
  finally { busy = false; }
}

if (require.main === module) {
  console.log('[watchdog] worker started (' + (runner.enabled() ? 'enabled' : 'idle: WATCHDOG_ENABLED is not true') + '; tick 5m)');
  setTimeout(tick, 90_000);   // stagger after startup so the server is answering
  setInterval(tick, TICK_MS);
}

module.exports = { tick };
