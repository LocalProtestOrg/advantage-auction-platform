'use strict';

/**
 * healthScoreService — Organization health / completion score (Phase 3C.1).
 * Derived from existing signals; cached to organizations.health_score for list views.
 * Extensible: additional components (opportunity, operational metrics) can be added later.
 */

const db = require('../db');

const COMPONENTS = [
  { key: 'claimed', weight: 20 },
  { key: 'verified', weight: 15 },
  { key: 'has_auction', weight: 15 },
  { key: 'has_event', weight: 10 },
  { key: 'recent_activity', weight: 10 },
  { key: 'marketplace', weight: 10 },
  { key: 'website', weight: 5 },
  { key: 'description', weight: 5 },
  { key: 'logo', weight: 5 },
  { key: 'profile', weight: 5 },
];
const CLAIMED_STATES = ['claimed', 'verified', 'active_partner', 'white_label_partner', 'enterprise_partner', 'partner_ambassador'];

async function signals(orgId) {
  const { rows } = await db.query(`
    SELECT o.lifecycle_state, o.verification_status, o.website_url, o.description, o.logo_url, o.city, o.state, o.contact_email, o.contact_phone,
      EXISTS(SELECT 1 FROM auctions a WHERE a.organization_id = o.id) AS has_auction,
      EXISTS(SELECT 1 FROM auctions a WHERE a.organization_id = o.id AND a.marketplace_status = 'syndicated' AND a.state IN ('published','active')) AS marketplace,
      EXISTS(SELECT 1 FROM events e WHERE e.organization_id = o.id AND e.status = 'published') AS has_event,
      EXISTS(SELECT 1 FROM organization_activity ac WHERE ac.organization_id = o.id AND ac.occurred_at > now() - interval '90 days') AS recent_activity
    FROM organizations o WHERE o.id = $1`, [orgId]);
  const o = rows[0];
  if (!o) return null;
  return {
    claimed: CLAIMED_STATES.includes(o.lifecycle_state),
    verified: o.verification_status === 'verified',
    has_auction: o.has_auction, has_event: o.has_event, recent_activity: o.recent_activity, marketplace: o.marketplace,
    website: !!o.website_url, description: !!o.description, logo: !!o.logo_url,
    profile: !!(o.city && o.state && (o.contact_email || o.contact_phone)),
  };
}

async function compute(orgId) {
  const s = await signals(orgId);
  if (!s) return null;
  let score = 0; const breakdown = {};
  for (const c of COMPONENTS) { const earned = s[c.key] ? c.weight : 0; score += earned; breakdown[c.key] = { earned, max: c.weight }; }
  return { score, breakdown };
}

/** Compute and cache the score on the organization row. */
async function recompute(orgId) {
  const r = await compute(orgId);
  if (!r) return null;
  await db.query('UPDATE organizations SET health_score = $2, health_computed_at = now() WHERE id = $1', [orgId, r.score]);
  return r;
}

module.exports = { compute, recompute, COMPONENTS };
