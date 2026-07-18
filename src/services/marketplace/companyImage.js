'use strict';

/**
 * companyImage — centralized, policy-respecting image selector for Marketplace
 * company profile cards.
 *
 * WHY THIS EXISTS: image fallback logic must live in ONE place (not scattered across
 * frontend components). Owner-approved image hierarchy (2026-07-18) — the Marketplace now
 * surfaces the company's own Brilliant Directories listing imagery, since these are public
 * directory listings on advantage.bid that the platform owner controls:
 *
 *   1. Linked seller's own logo             (seller_profiles.logo_url — seller-owned, Cloudinary)
 *   2. Linked seller's syndicated auction cover (auctions.cover_image_url — already public)
 *   3. BD company logo                       (bd_metadata.bd_image_url, type 'logo')
 *   4. BD listing photo / cover              (bd_metadata.bd_image_url, type 'photo')
 *   5. BD default directory asset            (bd_metadata.bd_image_url, type 'default')
 *   6. null → frontend draws a monogram      (absolute final fallback only)
 *
 * The company->seller link (organizations.linked_seller_profile_id) and the platform-managed
 * organizations.logo_url are never read/overwritten here — claimed-org and linked-seller
 * imagery stays authoritative. BD images live on www.advantage.bid, so cloudinaryDerivative
 * leaves them untouched (we only transform assets we own).
 *
 * FUTURE-PROOFING: the return shape carries `kind` (logo | photo | default) and `source` so a
 * future admin image-approval/override column can slot in as priority 0 without a redesign.
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
 *   { seller_logo_url, linked_auction_cover_url, bd_image_url, bd_image_type }
 * @returns {{url:string, kind:'logo'|'photo'|'default', source:string} | null}
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

  // 3–5. The company's own Brilliant Directories listing image (logo / photo / default asset).
  if (row.bd_image_url) {
    const t = row.bd_image_type;
    if (t === 'logo')    return { url: row.bd_image_url, kind: 'logo',    source: 'bd_logo' };
    if (t === 'default') return { url: row.bd_image_url, kind: 'default', source: 'bd_default' };
    return { url: row.bd_image_url, kind: 'photo', source: 'bd_photo' }; // 'photo' or unknown
  }

  // 6. No image at all — frontend draws a monogram (absolute final fallback).
  return null;
}

module.exports = { select, cloudinaryDerivative, PHOTO_TX, LOGO_TX };
