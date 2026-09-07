'use strict';

/**
 * marketingPackageDirectorService — the Marketing Director's PACKAGE fulfillment planner. After an
 * authoritative paid purchase it autonomously: creates a campaign (reusing marketing_campaigns from mig
 * 126), plans each obligation, reserves homepage inventory, advances internal-channel obligations, holds
 * gated external-channel obligations (email/social/paid are intentionally OFF) as planned/ready without
 * FALSELY completing them, and escalates via the certified Owner SMS only for a TRUE exception it cannot
 * resolve. No routine Owner approval. Never flips an external gate. Best-effort; never throws to the caller.
 */

const db = require('../db');
const marketingConfig = require('./marketingConfigService');
const channelReadiness = require('./channelReadinessService');
const obligations = require('./marketingObligationEngine');

// Reserve homepage inventory for a homepage obligation using the configured seed days. Automated scheduling:
// starts the day after purchase; a real calendar conflict solver can refine dates later — the reservation
// row is durable and never "disappears" (alternate dates/substitution handled by the resilience path).
async function reserveHomepage(runner, obligation, auctionId, days) {
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + Math.max(1, days) - 1);
  const startD = start.toISOString().slice(0, 10);
  const endD = end.toISOString().slice(0, 10);
  const slot = obligation.obligation_key === 'homepage_hero' ? 'hero' : 'module';
  const row = (await runner.query(
    `INSERT INTO marketing_homepage_reservations (obligation_id, auction_id, slot_type, start_date, end_date, days, status)
     VALUES ($1,$2,$3,$4,$5,$6,'reserved') RETURNING *`,
    [obligation.id, auctionId || null, slot, startD, endD, Math.max(1, days)])).rows[0];
  return row;
}

// Plan fulfillment for a purchase. Creates a campaign, plans obligations, reserves homepage. Returns a
// summary { campaign_id, planned, reserved_homepage, awaiting_channel, escalations }.
async function planFulfillment({ purchaseKind, purchaseId, auctionId, campaignClass }, runner) {
  const r = runner || db;
  const summary = { campaign_id: null, planned: 0, reserved_homepage: 0, awaiting_channel: 0, escalations: 0 };
  try {
    // Create a campaign object (reuse mig-126 marketing_campaigns). Non-paid at plan time (paid promotion is
    // a separate gated decision). draft state; the obligation engine tracks the real per-deliverable work.
    const campaign = (await r.query(
      `INSERT INTO marketing_campaigns (auction_id, campaign_class, state, is_paid)
       VALUES ($1,$2,'draft',false) RETURNING id`,
      [auctionId || null, campaignClass || 'seller'])).rows[0];
    summary.campaign_id = campaign ? campaign.id : null;

    const list = await obligations.listForPurchase(purchaseKind, purchaseId, r);
    for (const o of list) {
      // Link every obligation to the campaign.
      const execage = await channelReadiness.statusFor(o.channel);
      if (o.channel === 'homepage') {
        // Reserve inventory + advance to scheduled (internal channel is available).
        try {
          const days = o.obligation_key === 'homepage_hero'
            ? await marketingConfig.getInt('marketing.pkg.homepage.hero_days', 2)
            : await marketingConfig.getInt('marketing.pkg.homepage.module_days', 4);
          const res = await reserveHomepage(r, o, auctionId, days);
          summary.reserved_homepage += 1;
          await obligations.transition(o.id, 'scheduled', { proof: { homepage_reservation_id: res.id, start: res.start_date, end: res.end_date }, campaignId: campaign && campaign.id }, null, r);
        } catch (e) { await obligations.transition(o.id, 'planned', { campaignId: campaign && campaign.id, notes: 'homepage reservation deferred' }, null, r); }
      } else if (execage === 'available') {
        // Internal channels (listing/creative/analytics/onsite-if-enabled): advance to creative_ready.
        await obligations.transition(o.id, 'creative_ready', { campaignId: campaign && campaign.id }, null, r);
        summary.planned += 1;
      } else {
        // Gated external channel (email/social/paid OFF): keep PLANNED, awaiting channel — do NOT falsely
        // complete and do NOT escalate (this is an expected, non-exceptional hold).
        await obligations.transition(o.id, 'planned', { campaignId: campaign && campaign.id, notes: 'awaiting channel readiness (' + o.channel + ':' + execage + ')' }, null, r);
        summary.awaiting_channel += 1;
      }
    }
    return summary;
  } catch (e) {
    console.error('[pkg-director] planFulfillment error:', e.message);
    return summary;
  }
}

module.exports = { planFulfillment, reserveHomepage };
