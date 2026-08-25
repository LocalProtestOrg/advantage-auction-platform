'use strict';

/**
 * publicationGate — the hard "may this externally-discovered event become PUBLIC?" check.
 *
 * Product policy: an imported event must NOT be publicly visible unless the actual host company is
 * identified AND a company-controlled public destination (never the discovery source / a competitor) is
 * available, plus the basic quality/privacy conditions. This returns an explicit result with machine
 * reasons instead of silently substituting fallback data, so callers (the importer publish paths, admin
 * approval, and audits) can act or hold the record for review.
 *
 * Reason codes (internal only, never shown to the public):
 *   HARD (block publication):  title_missing · invalid_dates · expired_event · location_missing ·
 *                              image_missing · host_company_missing
 *   WARNING (do NOT block):    host_url_missing · image_placeholder_used (gov-surplus branded placeholder)
 *
 * Outbound-link policy (ratified Phase 5D §7 / 5F): a missing company-controlled outbound URL must NOT
 * block an otherwise-complete, trustworthy event — the Advantage.Bid event page stands on its own with
 * no outbound button (we NEVER substitute the discovery-source/competitor URL). The host COMPANY must
 * still be identified (host_company_missing stays hard); only the URL is downgraded to a warning.
 * (Ambiguous-company matching / stronger org verification are handled in the admin Review Queue.)
 */

const { pickHostDestination } = require('../../lib/externalUrlPolicy');
const { isGovSurplus, isNonPublicImage } = require('../../lib/govSurplusPlaceholder');

function toMs(v) { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null; }

/**
 * evaluatePublication(event, opts) → { ready: boolean, reasons: string[], warnings: string[] }
 *   reasons  = HARD blockers (ready is false iff reasons is non-empty)
 *   warnings = non-blocking notes recorded for the audit trail (currently: host_url_missing)
 * event fields used: source, title, start_at, end_at, event_format, city, state, lat, lng,
 *   organizer_name, registration_url, bidding_url, organizer_website_url, and an image signal
 *   (image_count | images[] | cover_image_url).
 */
function evaluatePublication(event, opts) {
  opts = opts || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const requireImage = opts.requireImage !== false;   // imported policy requires >= 1 image by default
  const e = event || {};
  const reasons = [];
  const warnings = [];

  if (!e.title || !String(e.title).trim()) reasons.push('title_missing');

  const start = toMs(e.start_at);
  const end = toMs(e.end_at);
  if (!e.start_at || start === null || (e.end_at && end === null) || (start !== null && end !== null && end < start)) {
    reasons.push('invalid_dates');
  }
  if (end !== null && end < now) reasons.push('expired_event');

  // Location/privacy: online events need no address; physical events need at least city+state or coords
  // (a raw street address is never required — and never exposed publicly).
  const online = String(e.event_format || '').toLowerCase() === 'online';
  if (!online && !(e.city && e.state) && !(e.lat != null && e.lng != null)) reasons.push('location_missing');

  // Image requirement. A real, publicly-displayable image satisfies it. GSA / Federal-Surplus auctions
  // have login-gated (ppms.gov 401) source photos that cannot be re-hosted, so a real image is
  // impossible — but every public surface renders the branded gov-surplus placeholder for them
  // (see govSurplusPlaceholder). For those events the requirement is satisfied by the guaranteed
  // placeholder (recorded as a warning, never a hard block). All OTHER imported events still require a
  // real image, so the quality bar is unchanged for estate sales and non-gov sources.
  const rawImage = e.cover_image_url || (Array.isArray(e.images) && e.images.length ? e.images[0] : null);
  const usableImage = rawImage && !isNonPublicImage(rawImage) ? rawImage : null;
  const imageCount = e.image_count != null ? Number(e.image_count) : (usableImage ? 1 : 0);
  const govSurplusPlaceholderApplies = isGovSurplus(e.external_url) && !usableImage;
  if (requireImage && !(imageCount > 0)) {
    if (govSurplusPlaceholderApplies) warnings.push('image_placeholder_used');
    else reasons.push('image_missing');
  }

  // Host company + company-controlled destination — evaluated only for externally discovered events.
  if (e.source === 'imported') {
    if (!e.organizer_name || !String(e.organizer_name).trim()) reasons.push('host_company_missing'); // HARD
    if (!pickHostDestination(e)) warnings.push('host_url_missing');  // WARNING: publish w/ no outbound link
  }

  return { ready: reasons.length === 0, reasons, warnings };
}

module.exports = { evaluatePublication };
