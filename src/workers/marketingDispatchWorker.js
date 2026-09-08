'use strict';

/**
 * marketingDispatchWorker — the autonomous email dispatch worker the durable queue was built to await
 * ("A separate worker ... added when autonomous marketing is ACTIVATED" — marketingQueueService). It runs
 * independently in production (forked worker, like marketingRefreshWorker) with no human at a computer.
 *
 * Each tick it asks emailDispatchService.runOnce() to claim due `email_dispatch` jobs (FOR UPDATE SKIP LOCKED)
 * and dispatch them via the certified sendCampaignLive path. SELF-GATED on marketing.a7_send_enabled — inert
 * (claims nothing, sends nothing) while A7 is off. Idempotent (queue idempotency_key + per-recipient UNIQUE),
 * bounded retry/backoff on failure. Never manufactures audience, never widens scope, never bypasses a gate.
 */
require('dotenv').config();
const dispatch = require('../services/emailDispatchService');

const POLL_MS = 60 * 1000;        // check the dispatch queue every minute
const BATCH = 5;                  // bounded jobs per tick

async function tick() {
  try {
    const out = await dispatch.runOnce({ max: BATCH });
    if (out.ran && out.dispatched > 0) {
      console.log('[marketingDispatch] dispatched', out.dispatched, 'campaign job(s):',
        JSON.stringify(out.results.map((x) => ({ id: x.id, sent: x.sent, skipped: x.skipped, error: x.error }))));
    }
  } catch (e) { console.error('[marketingDispatch] tick failed:', e.message); }
}

if (require.main === module) {
  console.log('[marketingDispatch] worker started (poll 60s; self-gated on marketing.a7_send_enabled; dispatches email_dispatch jobs via sendCampaignLive)');
  setTimeout(tick, 45_000);       // stagger initial run after startup
  setInterval(tick, POLL_MS);
}

module.exports = { tick };
