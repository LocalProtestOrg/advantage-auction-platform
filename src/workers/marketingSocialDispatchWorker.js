'use strict';

/**
 * marketingSocialDispatchWorker — the autonomous ORGANIC social dispatch worker (the social twin of
 * marketingDispatchWorker). Forked in production; claims due `social_dispatch` jobs and publishes via the
 * certified socialAdapter/metaGraphProvider path. DOUBLE self-gated: inert unless BOTH
 * marketing.a9_publish_enabled AND marketing.destinations.meta_enabled are true — both OFF now, so it claims
 * nothing and publishes nothing. Idempotent (queue key + per obligation/wave/platform), bounded retry/backoff.
 */
require('dotenv').config();
const dispatch = require('../services/socialDispatchService');

const POLL_MS = 60 * 1000;
const BATCH = 5;

async function tick() {
  try {
    const out = await dispatch.runOnce({ max: BATCH });
    if (out.ran && out.dispatched > 0) {
      console.log('[marketingSocial] dispatched', out.dispatched, 'social job(s):',
        JSON.stringify(out.results.map((x) => ({ id: x.id, ok: x.ok, shadow: x.shadow, error: x.error }))));
    }
  } catch (e) { console.error('[marketingSocial] tick failed:', e.message); }
}

if (require.main === module) {
  console.log('[marketingSocial] worker started (poll 60s; self-gated on marketing.a9_publish_enabled + marketing.destinations.meta_enabled; publishes social_dispatch jobs via socialAdapter)');
  setTimeout(tick, 50_000);
  setInterval(tick, POLL_MS);
}

module.exports = { tick };
