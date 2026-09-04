'use strict';

/**
 * directorReportService — a concise OPERATIONAL report for the Owner. Headlines marketplace outcomes and
 * absolute dollars; NEVER headlines clicks/impressions/opens/followers/utilization%. Includes what was
 * DECLINED and what LOST/was inconclusive (not just wins). Read-only.
 */
const db = require('../db');
const audiences = require('../lib/behavioralAudiences');
const membership = require('./audienceMembershipService');
const growthBridge = require('./growthBridgeService');

async function generate(runner) {
  const r = runner || db;
  const q = async (sql, p) => (await r.query(sql, p || [])).rows;

  const counts = await membership.counts(r);
  const noticed = await q(`SELECT opportunity_type, objective, subject_ref, size_estimate, rank_index, ranking_reason
                             FROM marketing_opportunities WHERE status = 'ranked' ORDER BY rank_index ASC NULLS LAST LIMIT 20`);
  const declinedOpps = await q(`SELECT opportunity_type, objective, subject_ref, decline_reason
                                  FROM marketing_opportunities WHERE status = 'declined' ORDER BY detected_at DESC LIMIT 20`);
  const decisions = await q(`SELECT decision, count(*)::int n FROM marketing_decisions GROUP BY decision`);
  const declinedDecisions = await q(`SELECT decision_reason, count(*)::int n FROM marketing_decisions WHERE decision = 'decline' GROUP BY decision_reason`);
  const experiments = await q(`SELECT verdict, count(*)::int n FROM marketing_experiments GROUP BY verdict`).catch(() => []);
  const learnings = await q(`SELECT statement, verdict, confidence FROM marketing_learnings ORDER BY valid_as_of DESC LIMIT 10`).catch(() => []);

  // Spend in absolute dollars (from the marketing ledger if present; else 0). No utilization %.
  let spentCents = 0; let authorityCents = 0;
  try { spentCents = Number((await q(`SELECT COALESCE(SUM(amount_cents),0)::bigint c FROM marketing_ledger WHERE amount_cents > 0`))[0].c) || 0; } catch (_) {}
  try { authorityCents = Number((await q(`SELECT COALESCE((value::text)::int,0) c FROM platform_config WHERE key = 'marketing.growth_monthly_additional_authority_cents'`))[0].c) || 0; } catch (_) {}

  // Standing marketplace figures.
  const crossoverSize = counts['buyer_showing_seller_intent'] || 0;
  const stopped = await q(`SELECT count(*)::int n FROM marketing_decisions WHERE decision = 'stop'`);

  return {
    generated_for: 'owner',
    what_we_noticed: noticed,
    what_we_did: decisions,
    what_we_declined: declinedOpps,
    why_declined: declinedDecisions,
    what_happened: { experiments_by_verdict: experiments },
    what_we_learned: learnings,
    what_we_stopped: stopped[0] ? stopped[0].n : 0,
    what_is_blocked: [
      { item: 'A7 autonomous email', status: 'OFF (owner SES feedback loop + enable)' },
      { item: 'Google Ads', status: 'OFF (not connected)' },
      { item: 'Meta', status: 'OFF (not connected)' },
    ],
    what_is_next: noticed.slice(0, 3).map((o) => o.subject_ref),
    standing_figures: {
      buyer_seller_crossover_audience: crossoverSize,
      audience_counts: counts,
      spend_dollars: (spentCents / 100).toFixed(2),
      remaining_authority_dollars: (Math.max(0, authorityCents - spentCents) / 100).toFixed(2),
    },
    note: 'Marketplace outcomes + absolute dollars. Clicks/impressions/opens/followers/utilization are intentionally not headlined.',
  };
}

// Buyer→Seller crossover operational readiness (§18). It may remain WAITING on accumulation.
async function crossoverReadiness(runner) {
  const r = runner || db;
  const def = audiences.get('buyer_showing_seller_intent');
  const counts = await membership.counts(r);
  const size = counts['buyer_showing_seller_intent'] || 0;
  const powered = size >= growthBridge.MIN_VIABLE_AUDIENCE;
  return {
    audience_key: 'buyer_showing_seller_intent',
    current_members: size,
    minimum_viable_size: growthBridge.MIN_VIABLE_AUDIENCE,
    powered,
    status: powered ? 'READY_FOR_EXPERIMENT' : 'WAITING_ON_ACCUMULATION',
    onsite_treatment_ready: true,     // buyer_seller_cta playbook exists
    email_ready: false,               // A7 off
    paid_ready: false,                // Google/Meta off
    purpose: def ? def.purpose : null,
  };
}

module.exports = { generate, crossoverReadiness };
