'use strict';

/**
 * ownerDigestWorker: the daily owner review digest (ownerReviewDigestService), 9:00 AM America/New_York.
 * Checks once a minute. The service decides everything (due time, one run per day, retries), so a restart, a second
 * instance or a missed minute never sends twice. Active in production; OWNER_DIGEST_DISABLED=true turns it off.
 */

require('dotenv').config();
const digest = require('../services/ownerReviewDigestService');

const CHECK_INTERVAL_MS = 60_000;

let running = false;
async function tick() {
  if (running) return;                      // one step at a time inside this process
  running = true;
  try { await digest.runDigestTick(); } catch (_) { /* never crash the worker */ } finally { running = false; }
}

if (require.main === module) {
  console.log(digest.enabled()
    ? '[owner-digest] scheduler active: daily at 9:00 AM America/New_York'
    : '[owner-digest] scheduler idle: disabled (production only, or OWNER_DIGEST_DISABLED=true); worker stays alive, no runs');
  setInterval(() => { tick(); }, CHECK_INTERVAL_MS);
  tick();
}

module.exports = { tick };
