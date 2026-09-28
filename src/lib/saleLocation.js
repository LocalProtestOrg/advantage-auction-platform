'use strict';

/**
 * saleLocation — the ONE authoritative answer to "where does this sale happen?" for sales tax (owner rule, 2026-09-28).
 *
 *   Auction (pickup)                → the auction's pickup address (auctions.street_address / city / address_state / zip).
 *   Storefront item from a lot      → the originating auction's pickup address, copied onto the item at conversion
 *                                     (marketplace_items.pickup_*), unless the seller later changes the item's location.
 *   Independent storefront item     → the pickup location the seller entered for that item (marketplace_items.pickup_*).
 *   Shipped storefront order        → origin = the item's pickup location; destination = the buyer's ship-to address.
 *   Missing / incomplete location   → the sale is BLOCKED with a message naming what is missing.
 *
 * Never used as a sale location: the buyer's billing address, the seller's legal/agreement address, or Advantage.Bid's
 * own head-office address (that is Stripe ACCOUNT configuration, not a per-transaction location).
 *
 * Pure: no database access. Callers load rows and pass them in.
 */

const US_STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM '
  + 'NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP').split(' '));

const trim = (v) => (v == null ? '' : String(v).trim());

function normalize(a) {
  if (!a) return null;
  return {
    line1: trim(a.line1) || null,
    line2: trim(a.line2) || null,
    city: trim(a.city) || null,
    state: trim(a.state).toUpperCase() || null,
    postal_code: trim(a.postal_code) || null,
    country: (trim(a.country) || 'US').toUpperCase(),
  };
}

// Plain-language names for each missing part (shown to sellers and admins).
const PART_LABEL = { line1: 'street address', city: 'city', state: 'state', postal_code: 'ZIP code' };

/** Which required parts are missing or invalid. Empty array = complete. */
function missingParts(a) {
  const n = normalize(a) || {};
  const out = [];
  if (!n.line1) out.push(PART_LABEL.line1);
  if (!n.city) out.push(PART_LABEL.city);
  if (!n.state || (n.country === 'US' && !US_STATES.has(n.state))) out.push(PART_LABEL.state);
  if (!n.postal_code || (n.country === 'US' && !/^\d{5}(-\d{4})?$/.test(n.postal_code))) out.push(PART_LABEL.postal_code);
  return out;
}

const isComplete = (a) => missingParts(a).length === 0;

/** "street address and ZIP code" — for messages. */
function describeMissing(parts) {
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/** An auction row (street_address, city, address_state, zip) → address. */
function fromAuction(row) {
  if (!row) return null;
  return normalize({ line1: row.street_address, city: row.city, state: row.address_state, postal_code: row.zip, country: 'US' });
}

/** A marketplace_items row (pickup_* columns) → address. */
function fromItemPickup(row) {
  if (!row) return null;
  return normalize({ line1: row.pickup_address_line1, line2: row.pickup_address_line2, city: row.pickup_city,
    state: row.pickup_state, postal_code: row.pickup_postal_code, country: row.pickup_country || 'US' });
}

/** Seller-supplied pickup fields ({ pickup_address_line1, … } or { line1, … }) → address. */
function fromInput(input) {
  if (!input) return null;
  return normalize({
    line1: input.pickup_address_line1 != null ? input.pickup_address_line1 : input.line1,
    line2: input.pickup_address_line2 != null ? input.pickup_address_line2 : input.line2,
    city: input.pickup_city != null ? input.pickup_city : input.city,
    state: input.pickup_state != null ? input.pickup_state : input.state,
    postal_code: input.pickup_postal_code != null ? input.pickup_postal_code : input.postal_code,
    country: input.pickup_country != null ? input.pickup_country : input.country,
  });
}

/** Raised when a sale has no usable location. Carries the missing parts so callers can tell the seller/admin. */
function locationError(code, who, parts, status = 422) {
  const what = describeMissing(parts);
  const e = new Error(who === 'buyer'
    ? 'The pickup location for this sale is incomplete, so sales tax can\'t be calculated yet. The seller has been asked to add it.'
    : `The pickup location is missing its ${what}. Add the full pickup address before continuing.`);
  e.code = code; e.status = status; e.userFacing = true; e.missing = parts;
  return e;
}

module.exports = { normalize, missingParts, isComplete, describeMissing, fromAuction, fromItemPickup, fromInput, locationError, US_STATES };
