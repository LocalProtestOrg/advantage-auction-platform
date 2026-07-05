'use strict';

/**
 * organizationsService — the foundational Organization business layer (Phase 1).
 *
 * Owns: onboarding (auto-create on first event), one-organization-per-user, ownership
 * checks, and plan lookup. Plans live at the org level (organization_plans). Verification,
 * multi-member roles, seller/auction linking, and monetization are DEFERRED (columns exist
 * but no behavior here). Spec: docs/projects/local-events-architecture.md.
 *
 * No changes to auctions/bids/payments/seller_profiles/users. Additive only.
 */

const db = require('../db');
const auditService = require('./auditService');
const { withTransaction } = require('../utils/withTransaction');
const capabilityService = require('./capabilityService');
const { generateUniqueSlug } = require('../utils/slug');
const { computeMatchKey } = require('./organizationMatchingService');

/** Structured, route-mappable error. */
function svcErr(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code; e.expose = true;
  return e;
}

/** Plan limits for a tier (or null if unknown). */
async function getPlan(planTier) {
  const { rows } = await db.query(
    `SELECT plan_tier, max_event_images, max_active_events, can_feature_events
       FROM organization_plans WHERE plan_tier = $1`, [planTier]);
  return rows[0] || null;
}

/** The user's single primary organization (owner membership preferred). One-org-per-user in P1. */
async function getPrimaryOrgForUser(userId) {
  const { rows } = await db.query(
    `SELECT o.*
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY (m.role = 'owner') DESC, o.created_at ASC
      LIMIT 1`, [userId]);
  return rows[0] || null;
}

async function getById(orgId) {
  const { rows } = await db.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
  return rows[0] || null;
}

/** True if the user is an active owner of the org. */
async function isOwner(userId, orgId) {
  const { rows } = await db.query(
    `SELECT 1 FROM organization_members
      WHERE organization_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active' LIMIT 1`,
    [orgId, userId]);
  return rows.length > 0;
}

/** The org's active owner (id + email), or null. Null-safe for inactive shells with no members. */
async function getOwner(orgId) {
  const { rows } = await db.query(
    `SELECT u.id, u.email FROM organization_members m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.role = 'owner' AND m.status = 'active' LIMIT 1`, [orgId]);
  return rows[0] || null;
}
async function hasOwner(orgId) { return !!(await getOwner(orgId)); }

/** Throw 403 unless the user owns the org. */
async function assertOwner(userId, orgId, client) {
  const runner = client || db;
  const { rows } = await runner.query(
    `SELECT 1 FROM organization_members
      WHERE organization_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active' LIMIT 1`,
    [orgId, userId]);
  if (!rows.length) throw svcErr(403, 'NOT_ORG_OWNER', 'You do not have access to this organization.');
}

/**
 * Onboarding — auto-create the user's organization on first event (idempotent, one-per-user).
 * If the user already has an organization, returns it unchanged. Requires name + a contact.
 */
async function onboardOrganization(userId, input = {}) {
  if (!userId) throw svcErr(401, 'UNAUTHENTICATED', 'Sign in required.');
  const name = (input.name || '').trim();
  const contactEmail = (input.contactEmail || '').trim();
  const contactPhone = (input.contactPhone || '').trim();
  if (!name) throw svcErr(400, 'ORG_NAME_REQUIRED', 'Organization name is required.');
  if (!contactEmail && !contactPhone) {
    throw svcErr(400, 'ORG_CONTACT_REQUIRED', 'A contact email or phone is required.');
  }

  const existing = await getPrimaryOrgForUser(userId);
  if (existing) return existing; // one org per user — never create a second

  return withTransaction(async (client) => {
    const slug = await generateUniqueSlug('organizations', name, client);
    // Self-service onboarding: the user IS the owner (no impersonation risk) → active_partner.
    const { rows } = await client.query(
      `INSERT INTO organizations (slug, name, type, contact_email, contact_phone, website_url, logo_url, city, state,
                                  lifecycle_state, source, match_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active_partner','onboarding',$10)
       RETURNING *`,
      [slug, name, input.type || null, contactEmail || null, contactPhone || null,
       input.websiteUrl || null, input.logoUrl || null, input.city || null, input.state || null,
       computeMatchKey(name, input.state)]);
    const org = rows[0];

    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [org.id, userId]);

    // Grant the organization its plan's capabilities (Constitution §11: plans grant capabilities).
    await capabilityService.grantPlanCapabilities(org.id, org.plan_tier, client);

    await auditService.logEvent(client, {
      eventType: 'organization.created', entityType: 'organization', entityId: org.id,
      actorId: userId, metadata: { name: org.name, plan_tier: org.plan_tier },
    });
    return org;
  });
}

/** Owner-only profile update (safe fields only; never slug/plan/verification). */
async function updateProfile(userId, orgId, input = {}) {
  const ALLOWED = ['name', 'type', 'contact_email', 'contact_phone', 'website_url', 'logo_url', 'city', 'state'];
  const sets = [];
  const vals = [];
  for (const col of ALLOWED) {
    if (Object.prototype.hasOwnProperty.call(input, col)) {
      vals.push(input[col]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) throw svcErr(400, 'NO_FIELDS', 'No updatable fields provided.');

  return withTransaction(async (client) => {
    await assertOwner(userId, orgId, client);
    vals.push(orgId);
    const { rows } = await client.query(
      `UPDATE organizations SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length} RETURNING *`, vals);
    if (!rows.length) throw svcErr(404, 'ORG_NOT_FOUND', 'Organization not found.');
    await auditService.logEvent(client, {
      eventType: 'organization.updated', entityType: 'organization', entityId: orgId,
      actorId: userId, metadata: { fields: sets.map((s) => s.split(' = ')[0]) },
    });
    return rows[0];
  });
}

module.exports = {
  svcErr,
  getPlan,
  getPrimaryOrgForUser,
  getById,
  isOwner,
  assertOwner,
  getOwner,
  hasOwner,
  onboardOrganization,
  updateProfile,
};
