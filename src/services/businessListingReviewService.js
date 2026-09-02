'use strict';

/**
 * businessListingReviewService — the submit → admin-review → APPROVE & PUBLISH workflow for native
 * Free Business Listings. One controlled server-side path performs every authoritative action so an
 * admin never hand-edits capabilities, JSON, lat/lng, or lifecycle for a normal legitimate business.
 *
 * State lives in organizations.profile_data (server-controlled — the profile schema drops these keys from
 * user input): review_status ∈ draft|submitted|changes_requested|rejected|published, plus requested_type,
 * review_reason, submitted_at, approved_by, approved_at. Publication requires ALL of: lifecycle
 * active_partner + a granted professional-type capability + profile_data.published=true + geocoded — the
 * exact criteria marketplaceVisibility.activeMarketplaceCompanySql checks. Reuses the platform geocoder,
 * capabilityService, auditService, and the org ownership guard. Never trusts client capability/lat/lng.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const capabilityService = require('./capabilityService');
const auditService = require('./auditService');
const orgs = require('./organizationsService');
const geocoder = require('./geocoding/mapboxProvider');
const profileSchema = require('../lib/professionalProfileSchema');

// Admin-grantable professional-type capabilities (a REQUESTED type from the company is advisory only).
const PROFESSIONAL_TYPE_CAPS = ['appraiser', 'auction_house', 'estate_sale_company',
  'professional_liquidator', 'consignment_company', 'moving_company', 'cleanout_company'];

class ListingReviewError extends Error {
  constructor(message, code = 'LISTING_REVIEW_ERROR', status = 400) { super(message); this.code = code; this.status = status; }
}

function isPublishReady(org) {
  const name = (org.name || '').trim();
  const hasLocation = !!((org.city && org.state) || (org.address && org.state));
  const hasContact = !!(org.contact_email || org.contact_phone);
  const hasDesc = !!((org.description || '').trim());
  const missing = [];
  if (!name) missing.push('company name');
  if (!hasLocation) missing.push('city and state');
  if (!hasContact) missing.push('a business email or phone');
  if (!hasDesc) missing.push('a short description');
  return { ok: missing.length === 0, missing };
}

// Merge server-controlled review keys into profile_data (read-modify-write inside the caller's txn).
async function mergeReviewData(client, orgId, patch) {
  const { rows } = await client.query('SELECT profile_data FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
  if (!rows.length) throw new ListingReviewError('Organization not found', 'ORG_NOT_FOUND', 404);
  const pd = (rows[0].profile_data && typeof rows[0].profile_data === 'object') ? rows[0].profile_data : {};
  Object.assign(pd, patch);
  await client.query('UPDATE organizations SET profile_data = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(pd), orgId]);
  return pd;
}

// Build a single-line geocoder query from an org's own location fields.
function orgLocationQuery(org) {
  return [org.address, org.city, org.state, org.zip].map((s) => (s || '').trim()).filter(Boolean).join(', ');
}

// ── Company: submit for review ────────────────────────────────────────────────
async function submitForReview(userId, { requestedType } = {}) {
  const org = await orgs.getPrimaryOrgForUser(userId);
  if (!org) throw new ListingReviewError('Create your business listing first.', 'NO_ORG', 404);
  const type = String(requestedType || org.type || '').trim().toLowerCase();
  if (!PROFESSIONAL_TYPE_CAPS.includes(type)) {
    throw new ListingReviewError('Please choose a valid business type.', 'INVALID_TYPE', 400);
  }
  const ready = isPublishReady(org);
  if (!ready.ok) {
    throw new ListingReviewError('Please complete: ' + ready.missing.join(', ') + '.', 'INCOMPLETE_PROFILE', 422);
  }
  const out = await withTransaction(async (client) => {
    await orgs.assertOwner(userId, org.id, client);
    const pd = await mergeReviewData(client, org.id, {
      review_status: 'submitted', requested_type: type, review_reason: null,
      submitted_at: new Date().toISOString(),
    });
    // Keep the free-text type column aligned with the requested classification (does NOT grant anything).
    await client.query('UPDATE organizations SET type = COALESCE(NULLIF(type, \'\'), $2) WHERE id = $1', [org.id, type]);
    await auditService.logEvent(client, {
      eventType: 'org_listing.submitted', entityType: 'organization', entityId: org.id, actorId: userId,
      metadata: { requested_type: type },
    });
    return { review_status: pd.review_status, requested_type: type, organization_id: org.id, name: org.name };
  });
  return out;
}

// ── Admin: review queue ─────────────────────────────────────────────────────────
async function listQueue(statusFilter = 'submitted') {
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.type, o.city, o.state, o.website_url, o.contact_email, o.contact_phone,
            o.lifecycle_state, o.source, o.lat, o.lng, o.description, o.profile_data,
            o.profile_data->>'requested_type' AS requested_type,
            o.profile_data->>'review_status'  AS review_status,
            o.profile_data->>'submitted_at'   AS submitted_at,
            EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active') AS has_owner
       FROM organizations o
      WHERE o.source <> 'bd_import'
        AND (o.profile_data->>'review_status') = $1
      ORDER BY (o.profile_data->>'submitted_at') ASC NULLS LAST, o.created_at ASC`, [statusFilter]);
  return rows.map((o) => ({
    id: o.id, name: o.name, requested_type: o.requested_type || o.type || null,
    city: o.city, state: o.state, website_url: o.website_url,
    has_email: !!o.contact_email, has_phone: !!o.contact_phone,
    lifecycle_state: o.lifecycle_state, geocoded: o.lat != null && o.lng != null,
    submitted_at: o.submitted_at, is_claim: o.source === 'claim' || o.lifecycle_state === 'claimed',
    completeness: profileSchema.completeness({ name: o.name, description: o.description, city: o.city, state: o.state,
      contact_email: o.contact_email, contact_phone: o.contact_phone, website_url: o.website_url }, o.profile_data || {}, []),
    publish_ready: isPublishReady(o).ok,
  }));
}

// Advisory duplicate candidates (NEVER auto-merged): same normalized name, or same match_key.
async function duplicateCandidates(org) {
  const { rows } = await db.query(
    `SELECT id, name, city, state, source, bd_listing_id FROM organizations
      WHERE id <> $1 AND (lower(btrim(name)) = lower(btrim($2)) OR (match_key IS NOT NULL AND match_key = $3))
      LIMIT 10`, [org.id, org.name || '', org.match_key || '__none__']);
  return rows;
}

async function getDetail(orgId) {
  const org = await orgs.getById(orgId);
  if (!org) throw new ListingReviewError('Organization not found', 'ORG_NOT_FOUND', 404);
  const owner = await orgs.getOwner(orgId);
  const caps = Array.from(await capabilityService.getEffectiveCapabilities(orgId));
  return {
    organization: {
      id: org.id, slug: org.slug, name: org.name, type: org.type, city: org.city, state: org.state,
      address: org.address || null, zip: org.zip || null, website_url: org.website_url,
      contact_email: org.contact_email, contact_phone: org.contact_phone, description: org.description,
      lifecycle_state: org.lifecycle_state, source: org.source, lat: org.lat, lng: org.lng,
      requested_type: (org.profile_data && org.profile_data.requested_type) || org.type || null,
      review_status: (org.profile_data && org.profile_data.review_status) || 'draft',
      published: !!(org.profile_data && org.profile_data.published),
    },
    owner_email: owner ? owner.email : null,
    professional_capabilities: caps.filter((c) => PROFESSIONAL_TYPE_CAPS.includes(c)),
    publish_ready: isPublishReady(org),
    duplicates: await duplicateCandidates(org),
  };
}

// ── Admin: APPROVE & PUBLISH (the one-click workflow) ────────────────────────────
// type: the admin-confirmed professional type (defaults to the requested type). lat/lng: optional
// admin-entered coordinates (used only when the org has none and auto-geocoding is unavailable/failed).
async function approveAndPublish(adminId, orgId, { type, lat, lng } = {}) {
  const current = await orgs.getById(orgId);
  if (!current) throw new ListingReviewError('Organization not found', 'ORG_NOT_FOUND', 404);
  if (current.source === 'bd_import') throw new ListingReviewError('BD-imported listings are managed separately.', 'NOT_NATIVE', 409);

  const chosenType = String(type || (current.profile_data && current.profile_data.requested_type) || current.type || '').trim().toLowerCase();
  if (!PROFESSIONAL_TYPE_CAPS.includes(chosenType)) {
    throw new ListingReviewError('Choose a valid professional type to approve.', 'INVALID_TYPE', 400);
  }
  const ready = isPublishReady(current);
  if (!ready.ok) throw new ListingReviewError('Cannot publish — missing: ' + ready.missing.join(', ') + '.', 'INCOMPLETE_PROFILE', 422);

  // Resolve coordinates BEFORE the transaction (network geocode must not hold a DB lock).
  let finalLat = current.lat, finalLng = current.lng, geocodeStatus = 'existing';
  if (finalLat == null || finalLng == null) {
    const bodyLat = Number(lat), bodyLng = Number(lng);
    if (Number.isFinite(bodyLat) && Number.isFinite(bodyLng)) {
      finalLat = bodyLat; finalLng = bodyLng; geocodeStatus = 'admin_entered';
    } else {
      const g = await geocoder.geocode(orgLocationQuery(current));
      if (g.ok) { finalLat = g.lat; finalLng = g.lng; geocodeStatus = 'geocoded'; }
      else {
        // Do NOT publish a company the directory cannot place. Admin corrects the location and retries.
        const e = new ListingReviewError('This business could not be located automatically. Confirm the address or enter coordinates, then retry.', 'LOCATION_NEEDS_REVIEW', 422);
        e.geocode = { status: g.status, error: g.error };
        throw e;
      }
    }
  }

  return withTransaction(async (client) => {
    // Grant ONLY the confirmed professional-type capability (admin-authoritative; source 'grant').
    await capabilityService.setCapability(orgId, chosenType, true, 'grant', client);
    // Establish an active public lifecycle + persist coordinates.
    await client.query(
      `UPDATE organizations SET lifecycle_state = 'active_partner', lat = $2, lng = $3, updated_at = now() WHERE id = $1`,
      [orgId, finalLat, finalLng]);
    // Authoritative published state + review status (server-only keys).
    await mergeReviewData(client, orgId, {
      published: true, review_status: 'published', review_reason: null,
      approved_by: adminId || null, approved_at: new Date().toISOString(),
    });
    await auditService.logEvent(client, {
      eventType: 'org_listing.approved', entityType: 'organization', entityId: orgId, actorId: adminId,
      metadata: { professional_type: chosenType, geocode: geocodeStatus },
    });
    const updated = await orgs.getById(orgId);
    return { organization_id: orgId, name: updated.name, professional_type: chosenType,
      published: true, lifecycle_state: updated.lifecycle_state, geocode: geocodeStatus, slug: updated.slug };
  });
}

async function requestChanges(adminId, orgId, reason) {
  const org = await orgs.getById(orgId);
  if (!org) throw new ListingReviewError('Organization not found', 'ORG_NOT_FOUND', 404);
  return withTransaction(async (client) => {
    await mergeReviewData(client, orgId, { review_status: 'changes_requested', review_reason: (reason || '').toString().slice(0, 1000) || null });
    await auditService.logEvent(client, {
      eventType: 'org_listing.changes_requested', entityType: 'organization', entityId: orgId, actorId: adminId,
      metadata: { reason: (reason || '').toString().slice(0, 1000) },
    });
    return { organization_id: orgId, name: org.name, review_status: 'changes_requested' };
  });
}

async function reject(adminId, orgId, reason) {
  const org = await orgs.getById(orgId);
  if (!org) throw new ListingReviewError('Organization not found', 'ORG_NOT_FOUND', 404);
  return withTransaction(async (client) => {
    // A rejected listing is NOT deleted (record + audit preserved); it also loses public publication.
    await mergeReviewData(client, orgId, { review_status: 'rejected', published: false, review_reason: (reason || '').toString().slice(0, 1000) || null });
    await auditService.logEvent(client, {
      eventType: 'org_listing.rejected', entityType: 'organization', entityId: orgId, actorId: adminId,
      metadata: { reason: (reason || '').toString().slice(0, 1000) },
    });
    return { organization_id: orgId, name: org.name, review_status: 'rejected' };
  });
}

module.exports = {
  PROFESSIONAL_TYPE_CAPS, ListingReviewError, isPublishReady, orgLocationQuery,
  submitForReview, listQueue, getDetail, duplicateCandidates, approveAndPublish, requestChanges, reject,
};
