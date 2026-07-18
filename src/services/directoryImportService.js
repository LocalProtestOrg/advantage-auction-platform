'use strict';

/**
 * directoryImportService — one-way BD -> Railway import (Phase 3B).
 * Creates INACTIVE Organization shells from normalized BD listings. Idempotent on
 * bd_listing_id; dedup via google_place_id, then match_key. Refreshes only unclaimed shells
 * (never overwrites claimed/enriched orgs). Logos are NOT mirrored (deferred until claim).
 * `plan()` is read-only (dry-run); `apply()` writes.
 */

const db = require('../db');
const lifecycle = require('./organizationLifecycleService');
const matching = require('./organizationMatchingService');

async function findExisting(l) {
  let org = await matching.findByBdListingId(l.bdListingId);
  if (org) return { org, via: 'bd_listing_id' };
  if (l.googlePlaceId) {
    const { rows } = await db.query('SELECT * FROM organizations WHERE google_place_id = $1 LIMIT 1', [l.googlePlaceId]);
    if (rows[0]) return { org: rows[0], via: 'google_place_id' };
  }
  const cands = await matching.findCandidatesByMatchKey(l.name, l.state);
  if (cands.length === 1) return { org: cands[0], via: 'match_key' }; // conservative: only unambiguous
  return { org: null, via: cands.length > 1 ? 'ambiguous' : 'new' };
}

/** Dry-run: classify each listing as create | update | link | skip (no writes). */
async function plan(listings) {
  const summary = { create: 0, update: 0, link: 0, skip_ambiguous: 0, items: [] };
  for (const l of listings) {
    const { org, via } = await findExisting(l);
    let action;
    if (!org) action = via === 'ambiguous' ? 'skip_ambiguous' : 'create';
    else if (via === 'bd_listing_id') action = 'update';
    else action = 'link';
    summary[action === 'create' ? 'create' : action === 'update' ? 'update' : action === 'link' ? 'link' : 'skip_ambiguous'] += 1;
    summary.items.push({ bdListingId: l.bdListingId, name: l.name, state: l.state, action, via, existingId: org ? org.id : null });
  }
  return summary;
}

function metaFor(l) {
  return {
    profession_id: l.professionId, subscription_name: l.subscriptionName, listing_type: l.listingType, zip: l.zip, source_bd: true,
    // Public listing imagery + canonical profile path (owner-approved for Marketplace display).
    // Stored in bd_metadata (NOT the platform-managed logo_url column) so claimed-org and
    // linked-seller imagery is never touched; refreshed on every unclaimed-shell true-sync.
    bd_image_url: l.bdImageUrl || null,
    bd_image_type: l.bdImageType || null,
    bd_profile_path: l.profilePath || null,
  };
}

/** Apply the import (writes). Idempotent. Optional {limit}. */
async function apply(listings, { limit } = {}) {
  const res = { created: 0, updated: 0, linked: 0, skipped: 0 };
  const slice = limit ? listings.slice(0, limit) : listings;
  for (const l of slice) {
    const { org, via } = await findExisting(l);
    if (!org) {
      if (via === 'ambiguous') { res.skipped += 1; continue; }
      const shell = await lifecycle.createShell({
        name: l.name, city: l.city, state: l.state,
        type: l.listingType === 'Individual' ? 'individual' : 'auction_company',
        contactEmail: l.contactEmail, contactPhone: l.contactPhone,
        bdListingId: l.bdListingId, source: 'bd_import',
      });
      await db.query(
        `UPDATE organizations SET google_place_id = $2, description = $3, lat = $4, lng = $5,
            website_url = COALESCE(website_url, $6), bd_metadata = $7 WHERE id = $1`,
        [shell.id, l.googlePlaceId, l.description, l.lat, l.lng, l.website, JSON.stringify(metaFor(l))]);
      res.created += 1;
    } else if (['inactive', 'directory_listing'].includes(org.lifecycle_state)) {
      // refresh unclaimed shell only; fill nulls, never overwrite; never touch logo
      await db.query(
        `UPDATE organizations SET
            bd_listing_id   = COALESCE(bd_listing_id, $2),
            google_place_id = COALESCE(google_place_id, $3),
            description     = COALESCE(description, $4),
            lat             = COALESCE(lat, $5),
            lng             = COALESCE(lng, $6),
            website_url     = COALESCE(website_url, $7),
            city            = COALESCE(city, $8),
            state           = COALESCE(state, $9),
            bd_metadata     = $10,
            updated_at      = now()
          WHERE id = $1`,
        [org.id, l.bdListingId, l.googlePlaceId, l.description, l.lat, l.lng, l.website, l.city, l.state, JSON.stringify(metaFor(l))]);
      res[via === 'bd_listing_id' ? 'updated' : 'linked'] += 1;
    } else {
      res.skipped += 1; // claimed/enriched org — never overwritten by import
    }
  }
  return res;
}

// ── Hardened one-way sync (BD -> Railway mirror) ────────────────────────────────
// True sync (BD is source of truth for public company fields), geocoding backfill for
// records BD returns without coordinates, and removal reconciliation. NEVER touches the
// verified company->seller link (linked_seller_profile_id), logos, or human-enriched
// (claimed+) orgs' fields. `apply=false` is a read-only dry run.
const bdDirectory = require('./bdDirectoryService');
const { geocodeAuctionLocation } = require('./geocoding');
const { computeMatchKey } = require('./organizationMatchingService');

const UNCLAIMED = ['inactive', 'directory_listing'];

async function syncFromBD({ apply = false, geocode = true, limit } = {}) {
  const { listings, seen, excluded } = await bdDirectory.listEligibleListings({});
  const slice = limit ? listings.slice(0, limit) : listings;
  const now = new Date();
  const s = {
    dryRun: !apply, bd_seen: seen, bd_excluded: excluded, eligible: listings.length, considered: slice.length,
    created: 0, updated_shell: 0, preserved_claimed: 0, geocoded: 0, geocode_failed: 0, no_coords: 0, reconciled_removed: 0,
  };

  // Geocoding backfill: fill missing coordinates so a listing can appear on the map.
  for (const l of slice) {
    if (l.lat != null && l.lng != null) continue;
    if (!geocode) { s.no_coords++; continue; }
    try {
      const r = await geocodeAuctionLocation({ street_address: l.street, city: l.city, address_state: l.state, zip: l.zip });
      if (r && r.latitude != null && r.longitude != null) { l.lat = r.latitude; l.lng = r.longitude; s.geocoded++; }
      else { s.geocode_failed++; }
    } catch (_) { s.geocode_failed++; }
    if (l.lat == null || l.lng == null) s.no_coords++;
  }

  for (const l of slice) {
    const { org } = await findExisting(l);
    if (!apply) {
      if (!org) s.created++;
      else if (UNCLAIMED.includes(org.lifecycle_state)) s.updated_shell++;
      else s.preserved_claimed++;
      continue;
    }
    if (!org) {
      const shell = await lifecycle.createShell({
        name: l.name, city: l.city, state: l.state,
        type: l.listingType === 'Individual' ? 'individual' : 'auction_company',
        contactEmail: l.contactEmail, contactPhone: l.contactPhone, bdListingId: l.bdListingId, source: 'bd_import',
      });
      await db.query(
        `UPDATE organizations SET google_place_id = $2, description = $3, lat = $4, lng = $5,
            website_url = $6, bd_metadata = $7, bd_synced_at = $8, bd_sync_status = 'active' WHERE id = $1`,
        [shell.id, l.googlePlaceId, l.description, l.lat, l.lng, l.website, JSON.stringify(metaFor(l)), now]);
      s.created++;
    } else if (UNCLAIMED.includes(org.lifecycle_state)) {
      // TRUE-SYNC: overwrite BD-owned public fields (BD is source of truth). The verified
      // link and the logo are intentionally excluded and never touched here.
      await db.query(
        `UPDATE organizations SET
            bd_listing_id = COALESCE(bd_listing_id, $2), name = $3, description = $4, city = $5, state = $6,
            website_url = $7, google_place_id = COALESCE($8, google_place_id), lat = $9, lng = $10,
            bd_metadata = $11, match_key = $12, bd_synced_at = $13, bd_sync_status = 'active', updated_at = now()
          WHERE id = $1`,
        [org.id, l.bdListingId, l.name, l.description, l.city, l.state, l.website, l.googlePlaceId, l.lat, l.lng,
         JSON.stringify(metaFor(l)), computeMatchKey(l.name, l.state), now]);
      s.updated_shell++;
    } else {
      // Claimed/enriched: a human owns this org — preserve their edits; only stamp freshness.
      await db.query(`UPDATE organizations SET bd_synced_at = $2, bd_sync_status = 'active' WHERE id = $1`, [org.id, now]);
      s.preserved_claimed++;
    }
  }

  // Removal reconciliation — ONLY on a full sync (no limit), else we'd wrongly flag unseen rows.
  if (!limit) {
    const present = new Set(slice.map((l) => String(l.bdListingId)));
    const { rows } = await db.query(
      `SELECT id, bd_listing_id FROM organizations
        WHERE source = 'bd_import' AND bd_listing_id IS NOT NULL
          AND (bd_sync_status IS NULL OR bd_sync_status <> 'removed')`);
    for (const r of rows) {
      if (present.has(String(r.bd_listing_id))) continue;
      s.reconciled_removed++;
      if (apply) await db.query(
        `UPDATE organizations SET bd_sync_status = 'removed', bd_synced_at = $2, updated_at = now() WHERE id = $1`, [r.id, now]);
    }
  }
  return s;
}

module.exports = { plan, apply, findExisting, syncFromBD };
