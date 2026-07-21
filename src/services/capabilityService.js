'use strict';

/**
 * capabilityService — organization-scoped capability grants (Constitution §11).
 * Plans grant capabilities; admins may grant/override beyond plan. Authorization asks
 * "does this org have capability X?" (see middleware/requireOrgCapability).
 */

const db = require('../db');

async function getPlanCapabilities(planTier, runner) {
  const { rows } = await (runner || db).query('SELECT capability FROM plan_capabilities WHERE plan_tier = $1', [planTier]);
  return rows.map((r) => r.capability);
}

/** Grant an organization its plan's capabilities (idempotent). Used at onboarding + plan change. */
async function grantPlanCapabilities(organizationId, planTier, runner) {
  await (runner || db).query(
    `INSERT INTO organization_capabilities (organization_id, capability, source)
       SELECT $1, capability, 'plan' FROM plan_capabilities WHERE plan_tier = $2
     ON CONFLICT (organization_id, capability) DO NOTHING`,
    [organizationId, planTier]);
}

/**
 * Reconcile plan-sourced capabilities to a NEW plan tier: drop the old plan's caps that the new
 * plan no longer grants, then add the new plan's caps. Admin grants/overrides (source != 'plan')
 * are preserved. Used when an admin changes an organization's tier.
 */
async function syncPlanCapabilities(organizationId, planTier, runner) {
  const r = runner || db;
  await r.query(
    `DELETE FROM organization_capabilities
      WHERE organization_id = $1 AND source = 'plan'
        AND capability NOT IN (SELECT capability FROM plan_capabilities WHERE plan_tier = $2)`,
    [organizationId, planTier]);
  await grantPlanCapabilities(organizationId, planTier, r);
}

async function getEffectiveCapabilities(organizationId) {
  const { rows } = await db.query(
    'SELECT capability FROM organization_capabilities WHERE organization_id = $1 AND enabled = true', [organizationId]);
  return new Set(rows.map((r) => r.capability));
}

async function hasCapability(organizationId, capability) {
  const { rows } = await db.query(
    'SELECT 1 FROM organization_capabilities WHERE organization_id = $1 AND capability = $2 AND enabled = true LIMIT 1',
    [organizationId, capability]);
  return rows.length > 0;
}

/** Admin: grant/revoke a capability beyond plan (source 'grant' | 'override'). */
async function setCapability(organizationId, capability, enabled, source = 'grant') {
  await db.query(
    `INSERT INTO organization_capabilities (organization_id, capability, enabled, source)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, capability)
       DO UPDATE SET enabled = EXCLUDED.enabled, source = EXCLUDED.source, updated_at = now()`,
    [organizationId, capability, enabled, source]);
}

module.exports = { getPlanCapabilities, grantPlanCapabilities, syncPlanCapabilities, getEffectiveCapabilities, hasCapability, setCapability };
