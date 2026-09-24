'use strict';

/**
 * acquisitionService — the hard attribution link (handoff section 8), independent of cookies:
 *
 *   token → message → sequence → cohort → company
 *
 * On claim, organizations.acquisition records { journey, cohort_id, sequence_id, message_id, template_key,
 * template_version, token_id, issue_channel, proof_method, claimed_at }. It is server-controlled and
 * written ONCE (never overwritten). When a member of that organization later creates a professional
 * seller profile, the record is copied to seller_profiles.acquisition so the conversion inherits the
 * journey with no guesswork. First-party only: nothing here is sent to an advertising platform.
 */

const db = require('../../db');
const events = require('./claimEvents');

const PRO_TYPES = ['auction_house', 'estate_sale_company', 'professional_liquidator'];

async function recordClaimAcquisition({ organizationId, tokenId = null, proofMethod }, runner = db) {
  const t = tokenId ? (await runner.query(`SELECT id, issue_channel FROM organization_claim_tokens WHERE id = $1`, [tokenId])).rows[0] : null;
  const m = tokenId ? (await runner.query(
    `SELECT m.id, m.sequence_id, m.template_key, m.template_version, s.cohort_id, s.company_id
       FROM listing_outreach_messages m LEFT JOIN listing_outreach_sequences s ON s.id = m.sequence_id
      WHERE m.token_id = $1 ORDER BY m.created_at DESC LIMIT 1`, [tokenId])).rows[0] : null;
  const org = (await runner.query(`SELECT bd_listing_id, source FROM organizations WHERE id = $1`, [organizationId])).rows[0] || {};
  const record = {
    journey: (org.bd_listing_id || org.source === 'bd_import') ? 'CLAIMED_LISTING' : null,
    cohort_id: m ? m.cohort_id : null, sequence_id: m ? m.sequence_id : null, message_id: m ? m.id : null,
    template_key: m ? m.template_key : null, template_version: m ? m.template_version : null,
    token_id: tokenId, issue_channel: t ? t.issue_channel : null, proof_method: proofMethod,
    claimed_at: new Date().toISOString(),
  };
  await runner.query(`UPDATE organizations SET acquisition = $2::jsonb WHERE id = $1 AND acquisition IS NULL`, [organizationId, JSON.stringify(record)]);
  return record;
}

/**
 * Copy an organization's acquisition record onto professional seller profiles created by its members,
 * and record pro_application / pro_conversion funnel events. Idempotent (only fills NULLs; events are
 * keyed). Safe to run on every worker tick.
 */
async function propagateToSellers(runner = db) {
  const rows = (await runner.query(
    `SELECT sp.id AS seller_profile_id, sp.user_id, sp.seller_type, sp.acquisition AS sp_acq, o.id AS organization_id, o.acquisition
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id AND m.status = 'active'
       JOIN seller_profiles sp ON sp.user_id = m.user_id
      WHERE o.acquisition IS NOT NULL AND sp.seller_type = ANY($1)`, [PRO_TYPES])).rows;
  let copied = 0;
  for (const r of rows) {
    if (!r.sp_acq) {
      const acq = Object.assign({}, r.acquisition, { inherited_from_organization_id: r.organization_id, inherited_at: new Date().toISOString() });
      const u = await runner.query(`UPDATE seller_profiles SET acquisition = $2::jsonb WHERE id = $1 AND acquisition IS NULL`, [r.seller_profile_id, JSON.stringify(acq)]);
      copied += u.rowCount;
    }
    await events.record('pro_application', { organizationId: r.organization_id, userId: r.user_id,
      meta: { seller_profile_id: r.seller_profile_id, seller_type: r.seller_type }, idempotencyKey: 'pa:' + r.seller_profile_id }, runner);
    // Conversion = that professional seller's first published auction or storefront listing.
    const conv = (await runner.query(
      `SELECT min(t) AS at FROM (
         SELECT a.created_at AS t FROM auctions a WHERE a.seller_id = $1 AND a.state IN ('published','active','closed')
         UNION ALL SELECT i.created_at FROM marketplace_items i WHERE i.seller_id = $1 AND i.status IN ('active','sold')) x`,
      [r.seller_profile_id]).catch(() => ({ rows: [] }))).rows[0];
    if (conv && conv.at) {
      await events.record('pro_conversion', { organizationId: r.organization_id, userId: r.user_id,
        meta: { seller_profile_id: r.seller_profile_id, first_published_at: conv.at }, idempotencyKey: 'pc:' + r.seller_profile_id }, runner);
      await require('../conversionService').record('claimed_listing_pro_conversion', { userId: r.user_id, subjectType: 'seller_profile', subjectId: r.seller_profile_id,
        idempotencyKey: 'clpc:' + r.seller_profile_id }).catch(() => {});
    }
  }
  return { candidates: rows.length, copied };
}

module.exports = { recordClaimAcquisition, propagateToSellers, PRO_TYPES };
