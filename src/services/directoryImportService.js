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
  return { profession_id: l.professionId, subscription_name: l.subscriptionName, listing_type: l.listingType, zip: l.zip, source_bd: true };
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

module.exports = { plan, apply, findExisting };
