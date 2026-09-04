'use strict';

/**
 * crmRankingService — reduced-power prospect prioritization from EXISTING facts (runnable even before
 * behavioral data). Filters actionable, unconverted, follow-up-due/unscheduled, not-recently-contacted
 * prospects and ranks by the Phase 3I tier order. Output: prospect + rank + one-line WHY + assigned rep.
 * DOES NOT contact anyone — human sales remains the action channel.
 */
const db = require('../db');

const RECENT_CONTACT_DAYS = 14;

// Tier + reason for one prospect (lower tier number = higher priority).
function tierFor(p) {
  const estate = /y|true|1/i.test(String(p.estate_sales_offered || ''));
  const online = /y|true|1/i.test(String(p.online_auctions_offered || ''));
  const web = String(p.website_status || '').toLowerCase();
  if (estate && !online) return { tier: 1, why: 'Offers estate sales but no online auction — strong fit for Advantage.Bid.' };
  if (['none', 'weak', 'outdated', 'no_website', 'broken'].includes(web) || !p.website) return { tier: 2, why: 'Weak/absent website — Advantage.Bid adds online reach.' };
  if ((p.priority === 'tier1' || p.priority === 'hot') && !p.priority_locked) return { tier: 4, why: 'Marked hot/tier-1 prospect.' };
  if (!p.last_contact_at) return { tier: 5, why: 'Qualified but never contacted.' };
  return { tier: 6, why: 'Actionable prospect awaiting follow-up.' };
}

async function rank({ limit = 50 } = {}, runner) {
  const r = runner || db;
  const { rows } = await r.query(
    `SELECT id, company_name, city, state, website, website_status, estate_sales_offered, online_auctions_offered,
            priority, priority_locked, contact_status, assigned_rep_user_id, last_contact_at, next_follow_up_at
       FROM sales_prospects
      WHERE COALESCE(is_actionable, true) = true
        AND converted_seller_profile_id IS NULL
        AND (next_follow_up_at IS NULL OR next_follow_up_at <= now())
        AND (last_contact_at IS NULL OR last_contact_at < now() - ($1 || ' days')::interval)
      LIMIT 500`, [String(RECENT_CONTACT_DAYS)]);
  const ranked = rows.map((p) => Object.assign({ prospect_id: p.id, company_name: p.company_name,
    location: [p.city, p.state].filter(Boolean).join(', '), assigned_rep_user_id: p.assigned_rep_user_id }, tierFor(p),
    { last_contact_at: p.last_contact_at }));
  ranked.sort((a, b) => (a.tier - b.tier) || (new Date(a.last_contact_at || 0) - new Date(b.last_contact_at || 0)));
  ranked.forEach((x, i) => { x.rank = i + 1; delete x.last_contact_at; });
  return { count: ranked.length, prospects: ranked.slice(0, limit), note: 'Prioritization only — human sales contacts prospects. No autonomous outreach.' };
}

module.exports = { rank, tierFor, RECENT_CONTACT_DAYS };
