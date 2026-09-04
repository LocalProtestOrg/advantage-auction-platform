'use strict';

/**
 * marketingContactService — generic, deduped marketing contact store keyed by normalized_email.
 *
 * CORE INVARIANT: SOURCE != PERMISSION. Where an address came from (platform buyer, legacy import, a
 * purchased list, a new-mover file) records ONLY provenance. It never establishes permission to email.
 * permission_basis defaults to 'unknown' and is only advanced by explicit evidence via grantPermission().
 * Nothing in upsert/attachSource ever promotes permission.
 *
 * Deliverable address resolution reuses recipientService (the BD-bridge rule), so a platform contact
 * linked to a user always points at users.contact_email || users.email, never a namespaced placeholder.
 */
const db = require('../db');
const { normalizeEmail } = require('../lib/emailNormalize');
const { resolveUserContactEmail } = require('./recipientService');

const VALID_BASIS = ['unknown', 'platform_relationship', 'explicit_opt_in', 'follower_optin', 'withdrawn'];

/**
 * Upsert a contact by normalized email. NEVER changes permission_basis. When userId is supplied, the
 * preferred_email is resolved through recipientService so linked contacts inherit the deliverable address.
 * @returns {object|null} the contact row, or null when the email is unusable.
 */
async function upsertContact({ email, userId = null, fullName = null, city = null, state = null, zip = null, isDemo = false,
  latitude = null, longitude = null, geographyPrecision = null, geographySource = null, geoResolvedAt = null } = {}, runner) {
  const r = runner || db;
  let preferred = email;
  if (userId) {
    const resolved = await resolveUserContactEmail(userId, r);
    if (resolved) preferred = resolved;
  }
  const normalized = normalizeEmail(preferred);
  if (!normalized) return null;
  // Geography columns only overwrite when NEW coordinates are actually supplied (COALESCE on EXCLUDED),
  // so an unrelated re-upsert never wipes a previously resolved location.
  const { rows } = await r.query(
    `INSERT INTO marketing_contacts (normalized_email, preferred_email, user_id, full_name, city, address_state, zip, is_demo,
        latitude, longitude, geography_precision, geography_source, geo_resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'unknown'),$12,$13)
     ON CONFLICT (normalized_email) DO UPDATE SET
       preferred_email = COALESCE(EXCLUDED.preferred_email, marketing_contacts.preferred_email),
       user_id     = COALESCE(EXCLUDED.user_id, marketing_contacts.user_id),
       full_name   = COALESCE(EXCLUDED.full_name, marketing_contacts.full_name),
       city        = COALESCE(EXCLUDED.city, marketing_contacts.city),
       address_state = COALESCE(EXCLUDED.address_state, marketing_contacts.address_state),
       zip         = COALESCE(EXCLUDED.zip, marketing_contacts.zip),
       latitude    = COALESCE(EXCLUDED.latitude, marketing_contacts.latitude),
       longitude   = COALESCE(EXCLUDED.longitude, marketing_contacts.longitude),
       geography_precision = CASE WHEN EXCLUDED.latitude IS NOT NULL THEN EXCLUDED.geography_precision ELSE marketing_contacts.geography_precision END,
       geography_source    = CASE WHEN EXCLUDED.latitude IS NOT NULL THEN EXCLUDED.geography_source    ELSE marketing_contacts.geography_source END,
       geo_resolved_at     = COALESCE(EXCLUDED.geo_resolved_at, marketing_contacts.geo_resolved_at),
       is_demo     = marketing_contacts.is_demo OR EXCLUDED.is_demo,
       updated_at  = now()
     RETURNING *`,
    [normalized, preferred, userId, fullName, city, state, zip, !!isDemo,
      latitude, longitude, geographyPrecision, geographySource, geoResolvedAt]);
  return rows[0];
}

/**
 * Attach a provenance record to a contact. Provenance is evidence only — it does NOT grant permission.
 * acquisition_date is stored as given and left NULL when genuinely unknown (never manufactured).
 */
async function attachSource(contactId, { sourceType, sourceRecordId = null, importSourceId = null, importRunId = null,
  importRunItemId = null, originalEmail = null, acquisitionDate = null, consentEvidence = null,
  vendorPermittedUses = null, batchRef = null } = {}, runner) {
  const r = runner || db;
  const { rows } = await r.query(
    `INSERT INTO marketing_contact_sources
       (contact_id, source_type, source_record_id, import_source_id, import_run_id, import_run_item_id,
        original_email, acquisition_date, consent_evidence, vendor_permitted_uses, batch_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (contact_id, source_type, source_record_id) DO NOTHING
     RETURNING *`,
    [contactId, sourceType, sourceRecordId, importSourceId, importRunId, importRunItemId,
      originalEmail, acquisitionDate, consentEvidence, vendorPermittedUses ? JSON.stringify(vendorPermittedUses) : null, batchRef]);
  return rows[0] || null;
}

/**
 * Advance (or withdraw) permission — the ONLY way permission_basis moves off 'unknown'. Requires explicit
 * evidence. 'withdrawn' is terminal for selection and records the withdrawal timestamp.
 */
async function grantPermission(contactId, { basis, scope = null, evidence = null, sourceType = null,
  signupPlacement = null, pagePath = null, referrer = null, ipHash = null } = {}, runner) {
  const r = runner || db;
  if (!VALID_BASIS.includes(basis)) throw new Error('invalid permission_basis');
  const withdrawn = basis === 'withdrawn';
  const { rows } = await r.query(
    `UPDATE marketing_contacts SET
       permission_basis = $2,
       permission_scope = COALESCE($3::jsonb, permission_scope),
       permission_evidence = COALESCE($4, permission_evidence),
       permission_established_at = CASE WHEN $5 THEN permission_established_at ELSE now() END,
       permission_withdrawn_at   = CASE WHEN $5 THEN now() ELSE permission_withdrawn_at END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [contactId, basis, scope ? JSON.stringify(scope) : null, evidence, withdrawn]);
  // Append-only audit: preserve the affirmative-action evidence over time.
  await recordPermissionEvent(contactId, {
    action: withdrawn ? 'withdrawn' : 'granted', basis, scope, sourceType, signupPlacement, evidence, pagePath, referrer, ipHash,
  }, r);
  return rows[0] || null;
}

/** Append an immutable permission-history row. Never mutates current state. */
async function recordPermissionEvent(contactId, { action, basis = null, scope = null, sourceType = null,
  signupPlacement = null, evidence = null, pagePath = null, referrer = null, ipHash = null } = {}, runner) {
  const r = runner || db;
  const { rows } = await r.query(
    `INSERT INTO marketing_contact_permission_events
       (contact_id, action, basis, scope, source_type, signup_placement, evidence, page_path, referrer, ip_hash)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [contactId, action, basis, scope ? JSON.stringify(scope) : null, sourceType, signupPlacement, evidence, pagePath, referrer, ipHash]);
  return rows[0] || null;
}

async function getByEmail(email, runner) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const { rows } = await (runner || db).query('SELECT * FROM marketing_contacts WHERE normalized_email = $1', [normalized]);
  return rows[0] || null;
}

module.exports = { upsertContact, attachSource, grantPermission, recordPermissionEvent, getByEmail, VALID_BASIS };
