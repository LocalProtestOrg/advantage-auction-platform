'use strict';

/**
 * professionalProvisioningService — connect an eligible BD professional (a bridge-authenticated
 * member) to their EXISTING imported Railway organization so they can create and manage marketplace
 * events, in ONE account, without re-enrolling as a private seller.
 *
 * Scope (Product Owner lock, Phase 4B). Grants ONLY marketplace/event access:
 *   1. owner membership on the member's OWN imported organization (never a new/duplicate org),
 *   2. the 'events' capability (the only gate on event submission),
 *   3. a human display name (fixes the `bd-###@bridge.invalid` placeholder).
 * It NEVER: touches BD billing/membership, creates a Railway subscription, creates a customer-facing
 * company-profile, duplicates the org or user, changes the user's role (buyer stays buyer-capable),
 * or steals an org already owned by someone else. Fully idempotent — safe to re-run.
 *
 * Business Administration (membership, billing, the company directory listing) remains BD-owned.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const capabilityService = require('./capabilityService');
const auditService = require('./auditService');

const PROVIDER = 'brilliant_directories';
const EVENT_CAPABILITY = 'events';
// Only an unclaimed shell may be moved to 'claimed'; never downgrade an already-active partner.
const CLAIMABLE_STATES = ['prospect', 'directory_listing', 'inactive'];

class ProvisionError extends Error {
  constructor(message, code = 'PROVISION_ERROR', status = 400) { super(message); this.code = code; this.status = status; }
}

/**
 * Pure, unit-testable ownership decision. Given the org's current active owner and the target user:
 *  - no owner            → 'create' (make this user the owner)
 *  - owner IS this user  → 'exists' (idempotent no-op)
 *  - owner is someone else→ 'conflict' (never steal an org)
 */
function decideMembership(currentOwnerUserId, userId) {
  if (!currentOwnerUserId) return 'create';
  if (String(currentOwnerUserId) === String(userId)) return 'exists';
  return 'conflict';
}

/** Resolve the bridge user for a BD member id (external_identities.provider_subject). */
async function findUserByBdMember(bdUserId, runner = db) {
  const { rows } = await runner.query(
    `SELECT u.id, u.full_name, ei.provider_first_name, ei.provider_last_name
       FROM external_identities ei JOIN users u ON u.id = ei.user_id
      WHERE ei.provider = $1 AND ei.provider_subject = $2 LIMIT 1`, [PROVIDER, String(bdUserId)]);
  return rows[0] || null;
}

/** Resolve the imported organization for a BD listing id. */
async function findOrgByBdListing(bdListingId, runner = db) {
  const { rows } = await runner.query(
    `SELECT * FROM organizations WHERE bd_listing_id = $1 AND source = 'bd_import' LIMIT 1`, [String(bdListingId)]);
  return rows[0] || null;
}

/**
 * Idempotently provision a professional. { userId, orgId, displayName?, actorId? }
 * Returns { userId, orgId, membership: 'created'|'exists', eventsGranted, displayNameSet }.
 * All writes share one transaction; re-running heals partial state and changes nothing already correct.
 */
async function provision({ userId, orgId, displayName = null, actorId = null }) {
  if (!userId || !orgId) throw new ProvisionError('userId and orgId are required', 'MISSING_FIELDS');
  return withTransaction(async (client) => {
    const { rows: orgRows } = await client.query('SELECT * FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
    const org = orgRows[0];
    if (!org) throw new ProvisionError('Organization not found', 'ORG_NOT_FOUND', 404);

    const { rows: ownerRows } = await client.query(
      "SELECT user_id FROM organization_members WHERE organization_id = $1 AND role = 'owner' AND status = 'active' LIMIT 1",
      [orgId]);
    const decision = decideMembership(ownerRows[0] && ownerRows[0].user_id, userId);
    if (decision === 'conflict') throw new ProvisionError('Organization is already owned by another account.', 'PROVISION_CONFLICT', 409);

    let membership = 'exists';
    if (decision === 'create') {
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'owner', status = 'active'`, [orgId, userId]);
      if (CLAIMABLE_STATES.includes(org.lifecycle_state)) {
        await client.query("UPDATE organizations SET lifecycle_state = 'claimed', updated_at = now() WHERE id = $1", [orgId]);
      }
      membership = 'created';
    }

    // Grant ONLY the events capability (marketplace event management). Idempotent upsert. The capability
    // `source` column is constrained to plan|grant|override; 'grant' is the system/admin grant path.
    // The BD-professional provenance is recorded in the audit metadata below, not the source column.
    const hadEvents = (await client.query(
      "SELECT 1 FROM organization_capabilities WHERE organization_id = $1 AND capability = $2 AND enabled = true LIMIT 1",
      [orgId, EVENT_CAPABILITY])).rows.length > 0;
    await capabilityService.setCapability(orgId, EVENT_CAPABILITY, true, 'grant', client);

    // Give the account a human display name if it has none (fixes the bridge placeholder in the UI).
    let displayNameSet = false;
    const nameToSet = (displayName || org.name || '').trim();
    if (nameToSet) {
      const upd = await client.query(
        "UPDATE users SET full_name = $2 WHERE id = $1 AND (full_name IS NULL OR full_name = '') RETURNING id",
        [userId, nameToSet]);
      displayNameSet = upd.rows.length > 0;
    }

    await auditService.logEvent(client, {
      eventType: 'organization.professional_provisioned', entityType: 'organization', entityId: orgId,
      actorId: actorId || null,
      metadata: { user_id: userId, membership, events_granted: !hadEvents, display_name_set: displayNameSet, source: 'bd_professional' },
    });
    return { userId, orgId, membership, eventsGranted: !hadEvents, displayNameSet };
  });
}

/**
 * Provision by BD ids: resolves the bridge user (member id) + the imported org (listing id), with an
 * optional name-prefix safety check so a mismatched mapping aborts instead of linking the wrong company.
 */
async function provisionByBdIds({ bdUserId, bdListingId, expectNameStartsWith = null, actorId = null }) {
  const user = await findUserByBdMember(bdUserId);
  if (!user) throw new ProvisionError(`No bridge user for BD member ${bdUserId}.`, 'USER_NOT_FOUND', 404);
  const org = await findOrgByBdListing(bdListingId);
  if (!org) throw new ProvisionError(`No imported organization for BD listing ${bdListingId}.`, 'ORG_NOT_FOUND', 404);
  if (expectNameStartsWith && !(org.name || '').toLowerCase().startsWith(String(expectNameStartsWith).toLowerCase())) {
    throw new ProvisionError(`Organization name does not match the expected company for listing ${bdListingId}.`, 'NAME_MISMATCH', 409);
  }
  const displayName = [user.provider_first_name, user.provider_last_name].filter(Boolean).join(' ').trim() || org.name;
  return provision({ userId: user.id, orgId: org.id, displayName, actorId });
}

/** Current marketplace-event provisioning status for a user (null if not an org member). */
async function getStatus(userId) {
  const { rows } = await db.query(
    `SELECT o.id AS org_id, o.name, o.lifecycle_state,
            (m.role = 'owner') AS is_owner,
            EXISTS (SELECT 1 FROM organization_capabilities c
                     WHERE c.organization_id = o.id AND c.capability = 'events' AND c.enabled = true) AS has_events
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY (m.role = 'owner') DESC, o.created_at ASC LIMIT 1`, [userId]);
  return rows[0] || null;
}

module.exports = {
  provision, provisionByBdIds, getStatus,
  decideMembership, findUserByBdMember, findOrgByBdListing,
  ProvisionError, EVENT_CAPABILITY, CLAIMABLE_STATES,
};
