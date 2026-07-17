'use strict';

/**
 * companySellerLink — write side of the Marketplace Phase 2 company->seller link.
 *
 * Admin-confirmed is the source of truth. This sets the DEDICATED
 * organizations.linked_seller_profile_id column (NOT the multi-tenant bridge
 * seller_profiles.organization_id). Every mutation is audited. The `rule`/`confidence`
 * provenance lets a future automatic rule record HOW a link was made using the same path.
 */

const db = require('../../db');
const { writeAuditLog } = require('../../lib/auditLog');

class LinkError extends Error {
  constructor(message, status = 400, code = 'LINK_ERROR') { super(message); this.status = status; this.code = code; }
}

async function getOrgLink(orgId, client = db) {
  const { rows } = await client.query(
    `SELECT o.id, o.name, o.source, o.linked_seller_profile_id, o.linked_seller_at, o.linked_seller_meta,
            sp.display_name AS linked_seller_name
       FROM organizations o
       LEFT JOIN seller_profiles sp ON sp.id = o.linked_seller_profile_id
      WHERE o.id = $1`, [orgId]);
  return rows[0] || null;
}

/**
 * Link a marketplace listing to a seller. Admin-confirmed by default.
 * @param {object} p { orgId, sellerProfileId, actorId, rule='admin_confirmed', confidence='confirmed', evidence }
 */
async function linkSeller({ orgId, sellerProfileId, actorId, rule = 'admin_confirmed', confidence = 'confirmed', evidence = null }) {
  if (!orgId || !sellerProfileId) throw new LinkError('orgId and sellerProfileId are required', 400, 'MISSING_FIELDS');

  const org = (await db.query(`SELECT id, source, linked_seller_profile_id FROM organizations WHERE id = $1`, [orgId])).rows[0];
  if (!org) throw new LinkError('Organization not found', 404, 'ORG_NOT_FOUND');
  if (org.source !== 'bd_import') throw new LinkError('Only marketplace directory listings can be linked to a seller', 400, 'NOT_A_LISTING');

  const seller = (await db.query(`SELECT id FROM seller_profiles WHERE id = $1`, [sellerProfileId])).rows[0];
  if (!seller) throw new LinkError('Seller profile not found', 404, 'SELLER_NOT_FOUND');

  // Enforce one-listing-per-seller (mirrors the partial-unique index) with a friendly error.
  const taken = (await db.query(
    `SELECT id, name FROM organizations WHERE linked_seller_profile_id = $1 AND id <> $2`, [sellerProfileId, orgId])).rows[0];
  if (taken) throw new LinkError(`That seller is already linked to "${taken.name}"`, 409, 'SELLER_ALREADY_LINKED');

  const before = org.linked_seller_profile_id;
  const meta = { rule, confidence, evidence, linked_at: null };
  await db.query(
    `UPDATE organizations
        SET linked_seller_profile_id = $2, linked_seller_at = now(), linked_seller_by = $3, linked_seller_meta = $4::jsonb
      WHERE id = $1`,
    [orgId, sellerProfileId, actorId || null, JSON.stringify(meta)]);

  await writeAuditLog({
    event_type: 'marketplace_company_linked', entity_type: 'organization', entity_id: orgId, actor_id: actorId || null,
    metadata: { seller_profile_id: sellerProfileId, rule, confidence, evidence, previous_seller_profile_id: before || null },
  });

  return await getOrgLink(orgId);
}

/** Remove the company->seller link. Audited. */
async function unlinkSeller({ orgId, actorId, reason = null }) {
  const org = (await db.query(`SELECT id, linked_seller_profile_id FROM organizations WHERE id = $1`, [orgId])).rows[0];
  if (!org) throw new LinkError('Organization not found', 404, 'ORG_NOT_FOUND');
  const before = org.linked_seller_profile_id;

  await db.query(
    `UPDATE organizations
        SET linked_seller_profile_id = NULL, linked_seller_at = NULL, linked_seller_by = NULL,
            linked_seller_meta = jsonb_build_object('unlinked_at', to_jsonb(now()), 'unlinked_reason', $2::text)
      WHERE id = $1`, [orgId, reason]);

  await writeAuditLog({
    event_type: 'marketplace_company_unlinked', entity_type: 'organization', entity_id: orgId, actor_id: actorId || null,
    metadata: { previous_seller_profile_id: before || null, reason },
  });

  return await getOrgLink(orgId);
}

module.exports = { linkSeller, unlinkSeller, getOrgLink, LinkError };
