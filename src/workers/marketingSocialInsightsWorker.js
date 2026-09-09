'use strict';

/**
 * marketingSocialInsightsWorker — the autonomous OBSERVE/MEASURE/INGEST worker for organic social. Forked in
 * production (no operator session required). Every 15 minutes it ingests due post-metric windows for REAL
 * published posts (bounded batch, idempotent per window, backoff on error) and once per day snapshots each
 * active destination's account facts. Self-gated on marketing.social.insights_enabled (FALSE → inert) and
 * structurally inert until a real publish exists (which itself requires A9 + Meta publishing gates).
 * READ-ONLY toward Meta: never publishes, replies, or changes settings.
 */
require('dotenv').config();
const insights = require('../services/socialInsightsService');

const POLL_MS = 15 * 60 * 1000;
const BATCH = 10;
let lastAccountDay = null;

async function tick() {
  try {
    const out = await insights.runOnce({ max: BATCH });
    if (out.ran && out.processed > 0) {
      console.log('[socialInsights] ingested', out.processed, 'window(s):',
        JSON.stringify(out.results.map((x) => ({ job: x.job_id, window: x.window, ok: x.ok, status: x.provider_status, error: x.error }))));
    }
    const day = new Date().toISOString().slice(0, 10);
    if (out.ran !== false && lastAccountDay !== day) {
      const acct = await insights.snapshotAccounts();
      if (acct.ran) { lastAccountDay = day; if (acct.results.length) console.log('[socialInsights] account snapshots', day, JSON.stringify(acct.results)); }
    }
  } catch (e) { console.error('[socialInsights] tick failed:', e.message); }
}

if (require.main === module) {
  console.log('[socialInsights] worker started (poll 15m; self-gated on marketing.social.insights_enabled; read-only Meta insights/comments for REAL published posts)');
  setTimeout(tick, 70_000);
  setInterval(tick, POLL_MS);
}

module.exports = { tick };
