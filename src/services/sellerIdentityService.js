'use strict';

/**
 * sellerIdentityService — expanded seller identity capture for agreements.
 * 1:1 with seller_profiles. Admin-managed in Phase A (no seller-facing surface).
 * SECURITY: payout_info_ref holds only a tokenized / non-sensitive reference —
 * never raw bank/card data. Every change writes a seller_identity_changed audit naming the changed fields (not values).
 */
const db = require('../db/index');
const { writeAuditLog } = require('../lib/auditLog');

const IDENTITY_FIELDS = [
  'legal_name', 'company_name', 'signatory_name', 'signatory_title',
  'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country',
  'phone', 'payout_info_ref',
];

// Field-level allow-list: what any caller (admin agreements, agreement variables) may read. Taxpayer numbers are never
// part of it (Advantage.Bid stores none — migration 202); only the verification status.
const READABLE_FIELDS = ['seller_profile_id', ...IDENTITY_FIELDS, 'dba_name', 'taxpayer_id_status', 'updated_by', 'updated_at'];
async function getIdentity(sellerProfileId) {
  const { rows } = await db.query(`SELECT ${READABLE_FIELDS.join(', ')} FROM seller_identity WHERE seller_profile_id = $1`, [sellerProfileId]);
  return rows[0] || null;
}

// Upsert: patch merged over the existing row (provided fields win; others retained).
async function upsertIdentity(sellerProfileId, patch, actorId) {
  const before = await getIdentity(sellerProfileId);
  const merged = {};
  for (const f of IDENTITY_FIELDS) merged[f] = (patch[f] !== undefined) ? patch[f] : (before ? before[f] : null);

  const placeholders = IDENTITY_FIELDS.map((_, i) => `$${i + 2}`);
  const updateSet = IDENTITY_FIELDS.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const params = [sellerProfileId, ...IDENTITY_FIELDS.map((c) => merged[c]), actorId ?? null];

  const { rows } = await db.query(
    `INSERT INTO seller_identity (seller_profile_id, ${IDENTITY_FIELDS.join(', ')}, updated_by, updated_at)
     VALUES ($1, ${placeholders.join(', ')}, $${IDENTITY_FIELDS.length + 2}, now())
     ON CONFLICT (seller_profile_id) DO UPDATE
       SET ${updateSet}, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING ${READABLE_FIELDS.join(', ')}`,
    params
  );
  await writeAuditLog({
    event_type: 'seller_identity_changed', entity_type: 'seller_identity',
    entity_id: sellerProfileId, actor_id: actorId ?? null,
    // Which fields changed — never the identity values themselves (no personal or tax data in the audit log).
    metadata: { changed_fields: IDENTITY_FIELDS.filter((f) => String((before || {})[f] ?? '') !== String(rows[0][f] ?? '')) },
  });
  return rows[0];
}

module.exports = { IDENTITY_FIELDS, getIdentity, upsertIdentity };
