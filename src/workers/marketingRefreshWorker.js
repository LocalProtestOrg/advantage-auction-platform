'use strict';

/**
 * marketingRefreshWorker — the smallest safe automated refresh for the marketing audience engine, so the
 * Owner never has to click "Refresh". Reuses the existing forked-worker infrastructure (no new queue).
 *
 * Cadence: platform-fact audiences (watcher/registered-non-bidder/local-event/abandoned-seller) refresh
 * on a SHORT cycle (closing/watcher state changes fast); derived behavioral signals + behavioral audience
 * membership refresh on a LONGER cycle. Self-gates on marketing.behavioral.enabled; idempotent; a failed
 * pass is logged and retried next tick. Never sends, never spends, never connects a provider.
 */
require('dotenv').config();
const marketingConfig = require('../services/marketingConfigService');
const platformFacts = require('../services/platformFactAudienceService');
const behavioralSignals = require('../services/behavioralSignalService');
const audienceMembership = require('../services/audienceMembershipService');

const FAST_MS = 15 * 60 * 1000;   // platform-fact audiences every 15 min
const COST_MS = 24 * 60 * 60 * 1000;   // Meta Ads cost facts once a day (READ-ONLY; last 3 days, providers restate)
const SLOW_MS = 60 * 60 * 1000;   // behavioral signal derivation + behavioral audiences hourly

async function fastPass() {
  try {
    if (!(await marketingConfig.getBool('marketing.behavioral.enabled', false))) return;
    const r = await platformFacts.refreshAll();
    console.log('[marketingRefresh] platform-fact audiences:', JSON.stringify(r));
  } catch (e) { console.error('[marketingRefresh] fast pass failed:', e.message); }
}

async function slowPass() {
  try {
    if (!(await marketingConfig.getBool('marketing.behavioral.enabled', false))) return;
    const s = await behavioralSignals.refreshRecent({ sinceHours: 24 * 7, limit: 1000 });
    const a = await audienceMembership.refreshAll();
    console.log('[marketingRefresh] behavioral:', JSON.stringify(s), 'behavioral audiences refreshed:', a.length);
  } catch (e) { console.error('[marketingRefresh] slow pass failed:', e.message); }
}

// Daily READ-ONLY Meta Ads cost pull (spend / impressions / clicks). Self-gates on the read gate
// marketing.measurement.meta_cost_ingestion_enabled — separate from the paid-ads gate, which is never touched here.
async function costPass() {
  try {
    if (!(await marketingConfig.getBool('marketing.measurement.meta_cost_ingestion_enabled', false))) return;
    const r = await require('../services/measurement/paidCostIngestionService').pull('meta_ads');
    console.log('[marketingRefresh] meta cost pull:', JSON.stringify({ pulled: r.pulled, reason: r.reason || null, rows: r.rows || 0, since: r.since || null, until: r.until || null }));
  } catch (e) { console.error('[marketingRefresh] meta cost pull failed:', e.message); }
}

if (require.main === module) {
  console.log('[marketingRefresh] worker started (fast 15m / slow 60m; gated on marketing.behavioral.enabled)');
  // Stagger the initial runs so startup isn't spiky.
  setTimeout(fastPass, 30_000);
  setTimeout(slowPass, 90_000);
  setInterval(fastPass, FAST_MS);
  setInterval(slowPass, SLOW_MS);
  setTimeout(costPass, 5 * 60_000);
  setInterval(costPass, COST_MS);
}

module.exports = { fastPass, slowPass, costPass };
