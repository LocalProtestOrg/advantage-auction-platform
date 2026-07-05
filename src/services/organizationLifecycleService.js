'use strict';

/**
 * organizationLifecycleService — the Organization lifecycle state machine (Phase 3A).
 *
 * States: prospect → directory_listing → inactive → claimed → verified → active_partner
 *         → white_label_partner → enterprise_partner → partner_ambassador.
 *
 * Security (Constitution §21/§22): claiming grants NO capabilities; capabilities begin at
 * `verified` (admin) and grow at `activate`. Every transition is audited. `lifecycle_state`
 * is the master status; `verify` also projects `verification_status='verified'`.
 *
 * Phase 3A builds the machine + `createShell` (used by 3B import) + `claim`/`verify`/`activate`.
 * Higher stages (white_label/enterprise/ambassador) are defined but not yet transitioned.
 */

const auditService = require('./auditService');
const { withTransaction } = require('../utils/withTransaction');
const { svcErr } = require('./organizationsService');
const { computeMatchKey } = require('./organizationMatchingService');
const { generateUniqueSlug } = require('../utils/slug');

const VERIFY_CAPABILITIES = ['organizations', 'events', 'widgets'];
const ACTIVATE_CAPABILITIES = ['auctions', 'imports', 'shipping'];

async function grant(client, orgId, caps, source) {
  for (const cap of caps) {
    await client.query(
      `INSERT INTO organization_capabilities (organization_id, capability, source) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, capability) DO UPDATE SET enabled = true, source = EXCLUDED.source, updated_at = now()`,
      [orgId, cap, source]);
  }
}
async function lockOrg(client, orgId) {
  const { rows } = await client.query('SELECT * FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
  if (!rows.length) throw svcErr(404, 'ORG_NOT_FOUND', 'Organization not found.');
  return rows[0];
}

/** Create an inactive Organization shell (no owner, no capabilities). Used by BD import (3B) + tests. */
async function createShell(input = {}) {
  const name = (input.name || '').trim();
  if (!name) throw svcErr(400, 'ORG_NAME_REQUIRED', 'Organization name is required.');
  return withTransaction(async (client) => {
    const slug = await generateUniqueSlug('organizations', name, client);
    const { rows } = await client.query(
      `INSERT INTO organizations (slug, name, type, city, state, contact_email, contact_phone,
                                  bd_listing_id, source, match_key, lifecycle_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'inactive') RETURNING *`,
      [slug, name, input.type || null, input.city || null, input.state || null,
       input.contactEmail || null, input.contactPhone || null,
       input.bdListingId || null, input.source || 'bd_import', computeMatchKey(name, input.state)]);
    const org = rows[0];
    await auditService.logEvent(client, {
      eventType: 'organization.shell_created', entityType: 'organization', entityId: org.id,
      actorId: null, metadata: { source: org.source, bd_listing_id: org.bd_listing_id },
    });
    return org;
  });
}

/** A user claims a claimable shell → becomes owner, state 'claimed'. Grants NO capabilities. */
async function claim(userId, orgId) {
  if (!userId) throw svcErr(401, 'UNAUTHENTICATED', 'Sign in required.');
  return withTransaction(async (client) => {
    const org = await lockOrg(client, orgId);
    // Owner-first: an org that already has an owner is ALREADY_CLAIMED (clearer than a state error).
    const { rows: owners } = await client.query(
      "SELECT 1 FROM organization_members WHERE organization_id=$1 AND role='owner' AND status='active' LIMIT 1", [orgId]);
    if (owners.length) throw svcErr(409, 'ALREADY_CLAIMED', 'This organization has already been claimed.');
    if (!['prospect', 'directory_listing', 'inactive'].includes(org.lifecycle_state)) {
      throw svcErr(409, 'NOT_CLAIMABLE', `Organization is not claimable (state: ${org.lifecycle_state}).`);
    }
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role, status) VALUES ($1,$2,'owner','active')
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role='owner', status='active'`, [orgId, userId]);
    const { rows } = await client.query(
      "UPDATE organizations SET lifecycle_state='claimed', updated_at=now() WHERE id=$1 RETURNING *", [orgId]);
    await auditService.logEvent(client, {
      eventType: 'organization.claimed', entityType: 'organization', entityId: orgId, actorId: userId, metadata: {},
    });
    return rows[0]; // NO capabilities granted at claim (Constitution §22)
  });
}

/** Admin verifies a claimed org → 'verified', sets verification_status, grants baseline capabilities. */
async function verify(adminId, orgId) {
  return withTransaction(async (client) => {
    const org = await lockOrg(client, orgId);
    if (org.lifecycle_state !== 'claimed') throw svcErr(409, 'INVALID_TRANSITION', `Cannot verify from '${org.lifecycle_state}'.`);
    const { rows } = await client.query(
      `UPDATE organizations SET lifecycle_state='verified', verification_status='verified',
         verified_at=now(), verified_by=$2, updated_at=now() WHERE id=$1 RETURNING *`, [orgId, adminId]);
    await grant(client, orgId, VERIFY_CAPABILITIES, 'grant');
    await auditService.logEvent(client, {
      eventType: 'organization.verified', entityType: 'organization', entityId: orgId, actorId: adminId,
      metadata: { capabilities: VERIFY_CAPABILITIES },
    });
    return rows[0];
  });
}

/** Admin activates a verified org → 'active_partner', grants operational capabilities. */
async function activate(adminId, orgId) {
  return withTransaction(async (client) => {
    const org = await lockOrg(client, orgId);
    if (org.lifecycle_state !== 'verified') throw svcErr(409, 'INVALID_TRANSITION', `Cannot activate from '${org.lifecycle_state}'.`);
    const { rows } = await client.query(
      "UPDATE organizations SET lifecycle_state='active_partner', updated_at=now() WHERE id=$1 RETURNING *", [orgId]);
    await grant(client, orgId, ACTIVATE_CAPABILITIES, 'grant');
    await auditService.logEvent(client, {
      eventType: 'organization.activated', entityType: 'organization', entityId: orgId, actorId: adminId,
      metadata: { capabilities: ACTIVATE_CAPABILITIES },
    });
    return rows[0];
  });
}

module.exports = { createShell, claim, verify, activate, VERIFY_CAPABILITIES, ACTIVATE_CAPABILITIES };
