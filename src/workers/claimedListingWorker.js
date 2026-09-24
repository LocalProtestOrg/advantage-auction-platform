'use strict';

/**
 * claimedListingWorker — the Claimed Listing programme's scheduler (every 10 minutes).
 *
 *   every tick   sequence scheduler (sends NOTHING while claimed_listings.sending_enabled is off; every
 *                send re-checks all nine gates) · expired user contact locks cleared
 *   hourly       activation sweep (milestones, day-21 stalled tasks) · acquisition → professional seller
 *                propagation (pro_application / pro_conversion)
 *   nightly      eligibility re-screen + deterministic scoring (persisted, no outreach)
 *
 * Every pass is idempotent and never throws out of the loop.
 */
require('dotenv').config();

const db = require('../db');
const sequences = require('../services/claimedListings/sequenceService');
const activation = require('../services/claimedListings/activationService');
const acquisition = require('../services/claimedListings/acquisitionService');
const eligibility = require('../services/claimedListings/eligibilityService');
const scoring = require('../services/claimedListings/scoringService');

const POLL_MS = 10 * 60 * 1000;
let lastHourly = 0;
let lastNightlyDate = null;

async function tableReady() {
  const r = await db.query(`SELECT to_regclass('public.listing_outreach_sequences') AS t`).catch(() => ({ rows: [{}] }));
  return !!(r.rows[0] && r.rows[0].t);
}

async function tick() {
  try {
    if (!(await tableReady())) return;   // migration 170 not applied yet: do nothing
    const s = await sequences.tick();
    if (s.sending_enabled && (s.attempted || s.queued)) console.log('[claimed-listing] tick', JSON.stringify(s));
    await db.query(`DELETE FROM company_contact_locks WHERE holder_type = 'user' AND expires_at <= now()`);

    if (Date.now() - lastHourly >= 60 * 60 * 1000) {
      lastHourly = Date.now();
      const a = await activation.sweep();
      const p = await acquisition.propagateToSellers();
      if (a.tracked || p.candidates) console.log('[claimed-listing] hourly', JSON.stringify({ activation: a, sellers: p }));
    }
    const today = new Date().toISOString().slice(0, 10);
    const hourUtc = new Date().getUTCHours();
    if (lastNightlyDate !== today && hourUtc === 8) {   // ~03:00-04:00 ET
      lastNightlyDate = today;
      const e = await eligibility.screen({ persist: true });
      const sc = await scoring.scoreAll({ persist: true });
      console.log('[claimed-listing] nightly screen', JSON.stringify({ counts: e.counts, tiers: sc.tiers }));
    }
  } catch (e) {
    console.error('[claimed-listing] worker pass failed:', e.message);
  }
}

console.log('[claimed-listing] worker started (poll 10m; sends nothing unless claimed_listings.sending_enabled and every send gate pass)');
setTimeout(tick, 30 * 1000);
setInterval(tick, POLL_MS);
