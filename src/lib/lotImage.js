'use strict';

/**
 * lotImage — the ONE authoritative lot-image fallback rule for Advantage.Bid.
 *
 * Policy: a lot shows its REAL uploaded photo(s); a lot with NO legitimate image shows the official
 * Advantage.Bid placeholder — never a fabricated, borrowed, or unrelated image. This is a PRESENTATION
 * resolution only: the database stays truthful (lot.images = [], images_count = 0, thumbnail_url = null
 * for an image-less lot) so sellers/admins/imports still know a real photo is missing. Never persist the
 * placeholder as if it were a supplied lot image, and never let it satisfy a "photo required" rule.
 *
 * The placeholder is a durable app static asset (served from /public), NOT a local dev path.
 */

const PLACEHOLDER_URL = '/img/lot-placeholder.png';

function isRealImageUrl(u) {
  if (u == null) return false;
  const s = String(u).trim();
  if (!s) return false;
  return s !== PLACEHOLDER_URL && !s.endsWith('/img/lot-placeholder.png');
}

// First genuine image from a lot-like object (checks images[] then thumbnail_url). Returns null if none.
function primaryRealImage(lot) {
  if (!lot) return null;
  const imgs = Array.isArray(lot.images) ? lot.images : null;
  if (imgs) {
    for (const it of imgs) {
      const u = (it && typeof it === 'object') ? (it.image_url || it.url) : it;
      if (isRealImageUrl(u)) return u;
    }
  }
  if (isRealImageUrl(lot.thumbnail_url)) return lot.thumbnail_url;
  return null;
}

// Resolve a single URL for DISPLAY: the real URL, or the placeholder. (Presentation only.)
function imageOrPlaceholder(url) {
  return isRealImageUrl(url) ? String(url) : PLACEHOLDER_URL;
}

// The DISPLAY image for a lot: its primary real image, or the placeholder. Does NOT mutate the lot.
function lotDisplayImage(lot) {
  return primaryRealImage(lot) || PLACEHOLDER_URL;
}

// True when the lot has NO genuine image (i.e. the placeholder will be shown). Truth signal for UX/reports.
function hasNoRealImage(lot) {
  return primaryRealImage(lot) == null;
}

module.exports = { PLACEHOLDER_URL, isRealImageUrl, primaryRealImage, imageOrPlaceholder, lotDisplayImage, hasNoRealImage };
