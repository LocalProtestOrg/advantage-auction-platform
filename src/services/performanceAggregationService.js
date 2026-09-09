'use strict';

/**
 * performanceAggregationService — Phase 3O Wave 2, blocker 7. Truthful campaign-performance aggregation that
 * FEEDS the existing seller allowlist renderer (sellerReportRenderer). Reads only real evidence rows and
 * classifies each metric explicitly:
 *   DELIVERED               — a real send/placement happened (non-shadow delivery/first_seen).
 *   MEASURED               — a real counter exists (impressions/clicks).
 *   INFLUENCED             — activity co-occurred with the campaign window (correlational — NEVER causal).
 *   ATTRIBUTION_UNAVAILABLE — not reliably measurable (opens, social engagement without provider metrics).
 *
 * Causality is never claimed just because a campaign preceded a bid/sale. SHADOW evidence is NOT reported to
 * sellers as delivered (it is certification-only). Confidential internals — economics, 60/40 policy, direct
 * authority ceiling, Growth Pool, provider cost, audience-sourcing mechanics, recipient identities, provider
 * failures, substitution cause, Director reasoning, profitability — are STRUCTURALLY excluded: this module only
 * ever emits the allowlisted metric map the renderer consumes.
 */

const db = require('../db');

const CLASS = { DELIVERED: 'DELIVERED', MEASURED: 'MEASURED', INFLUENCED: 'INFLUENCED', UNAVAILABLE: 'ATTRIBUTION_UNAVAILABLE' };

// Persist one performance fact (audit trail; separate from the seller payload).
async function writeFact(r, { purchaseKind, purchaseId, obligationId, metric, classification, value, source }) {
  await r.query(
    `INSERT INTO marketing_performance_facts (purchase_kind, purchase_id, obligation_id, metric, classification, value_numeric, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [purchaseKind || null, purchaseId || null, obligationId || null, metric, classification, value == null ? null : Number(value), source || null]);
}

/**
 * Aggregate all evidence for a set of obligations into (a) persisted facts and (b) the metric map keyed by
 * feature_key that sellerReportRenderer consumes. Only real (non-shadow) evidence becomes a DELIVERED/MEASURED
 * seller metric; shadow rows are summarized separately for internal certification, never surfaced to sellers.
 */
async function aggregate({ purchaseKind, purchaseId, obligations = [], auctionFacts = {} }, runner) {
  const r = runner || db;
  const metrics = {};      // seller-facing (allowlisted)
  const internal = { shadow_only: [] };

  for (const ob of obligations) {
    const key = ob.feature_key;

    // Owned placement — impressions/clicks (MEASURED) from real evidence.
    const pe = (await r.query(
      `SELECT COALESCE(SUM(impressions),0)::int imp, COALESCE(SUM(clicks),0)::int clk,
              BOOL_OR(first_seen_at IS NOT NULL) seen
         FROM marketing_placement_evidence WHERE obligation_id=$1 AND shadow=false`, [ob.id])).rows[0];
    if (pe && (pe.imp > 0 || pe.clk > 0)) {
      metrics[key] = { classification: CLASS.MEASURED, value: pe.imp };
      await writeFact(r, { purchaseKind, purchaseId, obligationId: ob.id, metric: `${key}_impressions`, classification: CLASS.MEASURED, value: pe.imp, source: 'placement_evidence' });
      if (pe.clk > 0) await writeFact(r, { purchaseKind, purchaseId, obligationId: ob.id, metric: `${key}_clicks`, classification: CLASS.MEASURED, value: pe.clk, source: 'placement_evidence' });
    } else if (pe && pe.seen) {
      metrics[key] = { classification: CLASS.DELIVERED, value: 1 };
    }

    // Shared email — real delivered count (DELIVERED) + card clicks (MEASURED). Shadow stays internal.
    const card = (await r.query(
      `SELECT c.delivered, c.clicks, e.shadow FROM marketing_email_edition_cards c
         JOIN marketing_email_editions e ON e.edition_id=c.edition_id
        WHERE c.obligation_id=$1 ORDER BY c.created_at DESC LIMIT 1`, [ob.id])).rows[0];
    if (card) {
      if (card.shadow === false && Number(card.delivered) > 0) {
        metrics[key] = { classification: CLASS.DELIVERED, value: Number(card.delivered) };
        if (Number(card.clicks) > 0) await writeFact(r, { purchaseKind, purchaseId, obligationId: ob.id, metric: `${key}_card_clicks`, classification: CLASS.MEASURED, value: Number(card.clicks), source: 'edition_card' });
      } else { internal.shadow_only.push({ feature_key: key, source: 'shared_email_shadow' }); }
    }

    // Dedicated email — real recipient_count (DELIVERED); opens ATTRIBUTION_UNAVAILABLE unless reliable.
    const ded = (await r.query(
      `SELECT recipient_count, opens, clicks, shadow, status FROM marketing_dedicated_sends WHERE obligation_id=$1 ORDER BY created_at DESC LIMIT 1`, [ob.id])).rows[0];
    if (ded) {
      if (ded.shadow === false && Number(ded.recipient_count) > 0) {
        metrics[key] = { classification: CLASS.DELIVERED, value: Number(ded.recipient_count) };
        if (ded.opens == null) await writeFact(r, { purchaseKind, purchaseId, obligationId: ob.id, metric: `${key}_opens`, classification: CLASS.UNAVAILABLE, value: null, source: 'dedicated_send' });
        if (Number(ded.clicks) > 0) await writeFact(r, { purchaseKind, purchaseId, obligationId: ob.id, metric: `${key}_clicks`, classification: CLASS.MEASURED, value: Number(ded.clicks), source: 'dedicated_send' });
      } else { internal.shadow_only.push({ feature_key: key, source: 'dedicated_shadow' }); }
    }

    // Social — publication proof (DELIVERED: a REAL provider publish has status 'published' + shadow=false);
    // engagement/reach are MEASURED only when the insights loop captured AVAILABLE provider metrics
    // (marketing_social_metric_snapshots), otherwise ATTRIBUTION_UNAVAILABLE. Shadow stays internal.
    const soc = (await r.query(
      `SELECT count(*) FILTER (WHERE status='published' AND shadow=false) real_pub,
              count(*) FILTER (WHERE status IN ('published_shadow','published')) any_pub
         FROM marketing_social_jobs WHERE obligation_id=$1`, [ob.id])).rows[0];
    if (soc) {
      if (Number(soc.real_pub) > 0) {
        metrics[key] = { classification: CLASS.DELIVERED, value: Number(soc.real_pub) };
        const snap = (await r.query(
          `SELECT ms.metrics FROM marketing_social_metric_snapshots ms JOIN marketing_social_jobs j ON j.id = ms.social_job_id
            WHERE j.obligation_id=$1 AND j.shadow=false ORDER BY ms.observed_at DESC`, [ob.id])).rows;
        const sum = (k) => snap.reduce((acc, s) => { const m = s.metrics && s.metrics[k]; return m && m.availability === 'available' && typeof m.value === 'number' ? (acc == null ? 0 : acc) + m.value : acc; }, null);
        const reach = sum('reach'); const eng = ['reactions', 'comments', 'shares', 'saves', 'clicks'].map(sum).reduce((a, v) => (v == null ? a : (a == null ? 0 : a) + v), null);
        if (reach != null) await writeFact(r, { purchaseKind, purchaseId, obligationId: ob.id, metric: `${key}_reach`, classification: CLASS.MEASURED, value: reach, source: 'meta_insights' });
        if (eng != null) { metrics[key] = { classification: CLASS.MEASURED, value: eng }; await writeFact(r, { purchaseKind, purchaseId, obligationId: ob.id, metric: `${key}_engagement`, classification: CLASS.MEASURED, value: eng, source: 'meta_insights' }); }
        else await writeFact(r, { purchaseKind, purchaseId, obligationId: ob.id, metric: `${key}_engagement`, classification: CLASS.UNAVAILABLE, value: null, source: 'social' });
      } else if (Number(soc.any_pub) > 0) { internal.shadow_only.push({ feature_key: key, source: 'social_shadow' }); }
    }
  }

  // Auction-level correlational signals — INFLUENCED (never causal). Only surfaced when real facts are provided.
  const infl = {};
  for (const [name, spec] of Object.entries({
    catalog_visits: 'catalog_visits', lot_engagement: 'lot_engagement', watchers: 'watchers',
    bidder_registrations: 'bidder_registrations', bids: 'bids',
  })) {
    const v = auctionFacts[spec];
    if (v != null) {
      infl[name] = { classification: CLASS.INFLUENCED, value: v };
      await writeFact(r, { purchaseKind, purchaseId, obligationId: null, metric: name, classification: CLASS.INFLUENCED, value: v, source: 'auction_facts' });
    }
  }

  return { metrics, influenced: infl, internal_certification: internal };
}

module.exports = { CLASS, aggregate, writeFact };
