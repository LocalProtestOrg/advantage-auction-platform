'use strict';

/**
 * crmService — CRM pipeline stage, follow-up, and recruitment/activation target lists (Phase 3C.1).
 * crm_stage is the relationship/sales funnel, kept SEPARATE from lifecycle_state (platform state).
 */

const db = require('../db');
const activity = require('./crmActivityService');
const { svcErr } = require('../utils/apiError');

const STAGES = ['prospect', 'contacted', 'demo_scheduled', 'interested', 'claimed', 'activated', 'inactive', 'former', 'ambassador'];

async function setStage(orgId, stage, actorId) {
  if (!STAGES.includes(stage)) throw svcErr(400, 'INVALID_STAGE', 'Unknown CRM stage.');
  const { rows } = await db.query('UPDATE organizations SET crm_stage = $2, updated_at = now() WHERE id = $1 RETURNING crm_stage', [orgId, stage]);
  if (!rows.length) throw svcErr(404, 'ORG_NOT_FOUND', 'Organization not found.');
  await activity.log(orgId, { activityType: 'status_change', actorId, subject: 'CRM stage → ' + stage, metadata: { crm_stage: stage } });
  return rows[0];
}

async function setNextAction(orgId, at) {
  await db.query('UPDATE organizations SET next_action_at = $2 WHERE id = $1', [orgId, at || null]);
}

/** Recruitment/activation target lists (ranked by health). */
async function targets(kind, opts = {}) {
  const { state, limit = 50 } = opts;
  const p = [];
  let where;
  if (kind === 'unclaimed_high_potential') where = "lifecycle_state = 'inactive' AND source = 'bd_import'";
  else if (kind === 'claimed_not_verified') where = "lifecycle_state = 'claimed'";
  else if (kind === 'verified_not_active') where = "lifecycle_state = 'verified'";
  else if (kind === 'going_stale') where = "lifecycle_state = 'active_partner' AND (last_contacted_at IS NULL OR last_contacted_at < now() - interval '60 days')";
  else throw svcErr(400, 'INVALID_TARGET', 'Unknown target list.');
  if (state) { p.push(state.toUpperCase()); where += ' AND state = $' + p.length; }
  p.push(limit);
  const { rows } = await db.query(
    `SELECT id, name, city, state, lifecycle_state, crm_stage, health_score
       FROM organizations WHERE ${where} ORDER BY health_score DESC NULLS LAST, name ASC LIMIT $${p.length}`, p);
  return rows;
}

module.exports = { setStage, setNextAction, targets, STAGES };
