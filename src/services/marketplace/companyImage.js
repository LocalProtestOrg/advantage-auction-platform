'use strict';

/**
 * companyImage — centralized, policy-respecting image selector for Marketplace
 * company profile cards.
 *
 * WHY THIS EXISTS: image fallback logic must live in ONE place (not scattered across
 * frontend components), and it must honor the platform's standing image-ownership
 * policy. That policy (see bdDirectoryService.js and directoryImportService.js) is:
 * Brilliant Directories / unclaimed-organization logos are DELIBERATELY WITHHELD until
 * an organization is claimed. This selector never surfaces a BD-sourced or unclaimed
 * `organizations.logo_url`. The only images it treats as approved-for-public-display are:
 *
 *   1. The linked seller's own logo        (seller_profiles.logo_url — seller-owned, Cloudinary)
 *   2. The linked seller's syndicated auction cover (auctions.cover_image_url — already public)
 *
 * Everything else resolves to `null`, and the frontend renders branded category
 * artwork (and finally a monogram). The company->seller link (organizations.
 * linked_seller_profile_id) is admin-confirmed, so an approved image only ever appears
 * for a company an administrator has deliberately connected to a real Advantage seller.
 *
 * FUTURE-PROOFING: the return shape carries `kind` (logo vs. photo) and `source` so a
 * future admin image-approval/override column can slot in here without a card redesign
 * or another migration. When such a field exists, add it as priority 0 in `select()`.
 */

// A Cloudinary delivery URL we control -> we can request a right-sized, optimized derivative
// by injecting a transform segment after `/upload/`. Any non-Cloudinary URL is returned as-is
// (never rewrite an external host we don't own).
const CLOUDINARY_RE = /^https?:\/\/res\.cloudinary\.com\/[^/]+\/(image|video)\/upload\//i;

function cloudinaryDerivative(url, transform) {
  if (!url || typeof url !== 'string') return url || null;
  if (!CLOUDINARY_RE.test(url)) return url;                 // not ours — leave untouched
  if (/\/upload\/(c_|w_|h_|q_|f_|e_|g_)/i.test(url)) return url; // already transformed — don't double-apply
  return url.replace(/\/upload\//i, `/upload/${transform}/`);
}

// Card-sized derivatives. Photos fill a 16:9-ish header; logos are contained (never cropped)
// and never upscaled past their intrinsic size.
const PHOTO_TX = 'c_fill,g_auto,w_640,h_360,q_auto,f_auto,dpr_auto';
const LOGO_TX  = 'c_limit,w_480,h_360,q_auto,f_auto,dpr_auto';

/**
 * Select the best approved image for a marketplace organization row.
 * @param {object} row expects (any may be null):
 *   { seller_logo_url, linked_auction_cover_url }
 * @returns {{url:string, kind:'logo'|'photo', source:string} | null}
 */
function select(row = {}) {
  // Priority 0 (future): an admin-approved organization image/override would go here.

  // 1. Linked seller's own logo — seller-owned, approved, contained treatment.
  if (row.seller_logo_url) {
    return { url: cloudinaryDerivative(row.seller_logo_url, LOGO_TX), kind: 'logo', source: 'seller_logo' };
  }

  // 2. Linked seller's syndicated auction cover — already public, photographic, fill treatment.
  if (row.linked_auction_cover_url) {
    return { url: cloudinaryDerivative(row.linked_auction_cover_url, PHOTO_TX), kind: 'photo', source: 'auction_cover' };
  }

  // 3+. No approved image — frontend renders branded category artwork, then a monogram.
  return null;
}

module.exports = { select, cloudinaryDerivative, PHOTO_TX, LOGO_TX };
