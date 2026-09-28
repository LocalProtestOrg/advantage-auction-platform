'use strict';

/**
 * marketplaceItemService — the first fixed-price Marketplace INVENTORY layer + the auction→marketplace
 * one-button lifecycle. A marketplace_item is an independent listing owned by a seller_profile; when it
 * originates from an unsold auction lot it references the source lot/auction (immutable audit) WITHOUT
 * ever mutating the lot/auction historical result (state, winning_*, payouts, settlement stay untouched).
 *
 * Ownership is always derived server-side from the authenticated user (never a client-supplied seller id).
 * Eligibility for one-button conversion = the authoritative UNSOLD set: lot closed, not withdrawn, no
 * winner, and no live/completed payment. Conversion is idempotent (unique source_lot_id) and transactional.
 *
 * This layer does NOT implement on-platform fixed-price CHECKOUT (that is a separate Stripe/payment
 * decision, deliberately deferred): a listing is a public, priced inventory record shown on the seller's
 * storefront + marketplace feed with a "contact seller to purchase" path.
 */

const db = require('../db');
const { withTransaction } = require('../utils/withTransaction');
const { isProfessional, brandingVisible } = require('../lib/sellerBranding');
const saleLocation = require('../lib/saleLocation');

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

// ── Pickup location (owner rule; see src/lib/saleLocation.js) ─────────────────────────────────────────
// Every storefront item can be picked up locally, so a LIVE item needs the actual place the buyer collects it:
//   normally the seller's confirmed DEFAULT storefront location (source 'default' — nothing stored on the item),
//   the originating auction's pickup address for a converted lot (source 'auction'), or a location the seller chose
//   for this one item (source 'item'). PUBLIC = city/state only; the full address never leaves the server publicly.
const PICKUP_COLUMNS = ['pickup_address_line1', 'pickup_address_line2', 'pickup_city', 'pickup_state', 'pickup_postal_code', 'pickup_country'];
const DEFAULT_COLUMNS = ['default_pickup_address_line1', 'default_pickup_address_line2', 'default_pickup_city', 'default_pickup_state',
  'default_pickup_postal_code', 'default_pickup_country', 'default_pickup_confirmed_at'];
const hasPickupInput = (o) => !!o && PICKUP_COLUMNS.some((k) => o[k] !== undefined);
function pickupRequiredError(missing) {
  const needsDefault = missing.includes('confirmed storefront pickup location');
  const e = err(422, needsDefault ? 'STOREFRONT_LOCATION_REQUIRED' : 'PICKUP_LOCATION_REQUIRED', needsDefault
    ? 'Confirm your storefront pickup location first (Items for Sale → Storefront pickup location). Your items use it automatically.'
    : `This item's pickup location is missing its ${saleLocation.describeMissing(missing)}. Complete it before the item can go live.`);
  e.missing = missing;
  return e;
}
// Public city/state/zip kept in step with the item's effective location (only city/state are ever public).
function publicPlace(loc) { return loc ? { city: loc.city, state: loc.state, zip: loc.postal_code } : { city: null, state: null, zip: null }; }
// Column values for a pickup address (normalized).
function pickupValues(loc, source) {
  return {
    pickup_address_line1: loc.line1, pickup_address_line2: loc.line2, pickup_city: loc.city, pickup_state: loc.state,
    pickup_postal_code: loc.postal_code, pickup_country: loc.country || 'US', pickup_location_source: source,
  };
}

// Resolve the acting user's own seller_profile (id, seller_type, is_demo, city/state via profile). Null if none.
async function sellerForUser(userId, runner = db) {
  const { rows } = await runner.query(
    `SELECT id, user_id, seller_type, is_demo, unsold_price_policy, ${DEFAULT_COLUMNS.join(', ')}
       FROM seller_profiles WHERE user_id = $1`, [userId]);
  return rows[0] || null;
}

// The authoritative "unsold + resaleable" predicate for a lot owned by :sellerId. Reserve enforcement is
// live: a lot whose reserve was not met closes with NO winner (reserve_not_met=true), so it is already
// covered by this null-winner predicate — no separate clause needed. conversion_reason distinguishes it.
const UNSOLD_JOIN = `
  FROM lots l
  JOIN auctions a ON a.id = l.auction_id
 WHERE a.seller_id = $1
   AND l.state = 'closed'
   AND l.is_withdrawn IS NOT TRUE
   AND l.winning_buyer_user_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.lot_id = l.id AND p.status IN ('pending','paid'))`;

// Eligible unsold lots for a seller that are NOT already converted (for the Unsold Inventory Center).
async function listUnsoldEligible(sellerId, runner = db) {
  const { rows } = await runner.query(
    `SELECT l.id, l.title, l.description, l.category, l.condition, l.thumbnail_url,
            l.reserve_cents, l.reserve_not_met, l.starting_bid_cents, l.current_bid_cents, l.bid_count,
            a.id AS auction_id, a.title AS auction_title, a.city, a.address_state AS state, a.zip,
            (SELECT count(*)::int FROM marketplace_items mi WHERE mi.source_lot_id = l.id) AS converted
     ${UNSOLD_JOIN}
       AND NOT EXISTS (SELECT 1 FROM marketplace_items mi WHERE mi.source_lot_id = l.id)
     ORDER BY a.end_time DESC NULLS LAST, l.lot_number ASC, l.lot_number_display ASC`, [sellerId]);
  return rows;
}

// Deterministic default asking price for an unsold lot (never exposes "reserve" as a concept downstream).
function defaultPrice(lot, policy) {
  const candidates = [lot.reserve_cents, lot.starting_bid_cents, lot.current_bid_cents].map((n) => Number(n) || 0);
  const first = candidates.find((n) => n > 0);
  return first || 0;
}

async function lotImages(lotId, runner = db) {
  const { rows } = await runner.query('SELECT image_url FROM lot_images WHERE lot_id = $1 ORDER BY sort_order ASC, created_at ASC', [lotId]);
  return rows.map((r) => r.image_url).filter(Boolean);
}

/**
 * ONE-BUTTON: convert an eligible unsold lot → a fixed-price marketplace listing. Server-derives ownership
 * from actingUserId; verifies professional + ownership + unsold eligibility; idempotent; transactional.
 * opts.priceCents (optional override), opts.edits (optional {title,description,price_cents,shippable,...}).
 * Returns { item, created }. Never mutates the source lot/auction.
 */
async function convertLotToListing(lotId, actingUserId, opts = {}) {
  return withTransaction(async (client) => {
    const seller = await sellerForUser(actingUserId, client);
    if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile for this user.');
    if (!isProfessional(seller.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Marketplace listings are for Professional Sellers.');

    // Idempotency: already converted → return the existing listing (repeat clicks are safe).
    const existing = (await client.query('SELECT * FROM marketplace_items WHERE source_lot_id = $1', [lotId])).rows[0];
    if (existing) return { item: existing, created: false };

    // Load the lot + its auction, scoped to THIS seller, and re-check unsold eligibility atomically.
    // NOTE: alias the auction's address_state to a_state so it does NOT collide with l.state (from l.*).
    const lot = (await client.query(
      `SELECT l.*, a.seller_id, a.city, a.address_state AS a_state, a.zip, a.id AS auction_id, a.is_demo AS auction_demo,
              a.street_address AS a_street
         FROM lots l JOIN auctions a ON a.id = l.auction_id
        WHERE l.id = $1 AND a.seller_id = $2 FOR UPDATE OF l`, [lotId, seller.id])).rows[0];
    if (!lot) throw err(404, 'LOT_NOT_FOUND', 'Lot not found or not owned by you.');
    if (lot.state !== 'closed') throw err(409, 'NOT_CLOSED', 'Only a closed auction lot can be moved to Marketplace.');
    if (lot.is_withdrawn) throw err(409, 'WITHDRAWN', 'This lot was withdrawn.');
    if (lot.winning_buyer_user_id) throw err(409, 'ALREADY_SOLD', 'This lot sold at auction and cannot be relisted.');
    const paid = (await client.query("SELECT 1 FROM payments WHERE lot_id = $1 AND status IN ('pending','paid') LIMIT 1", [lotId])).rows[0];
    if (paid) throw err(409, 'HAS_PAYMENT', 'This lot has an active purchase and cannot be relisted.');

    const price = opts.priceCents != null ? Math.max(0, parseInt(opts.priceCents, 10)) : defaultPrice(lot, seller.unsold_price_policy);
    if (!price || price <= 0) throw err(422, 'PRICE_REQUIRED', 'Set a Marketplace price (no reserve/start price was available to default from).');
    const images = await lotImages(lotId, client);
    const e = opts.edits || {};
    const reason = lot.reserve_not_met ? 'reserve_not_met' : (lot.bid_count > 0 ? 'unsold' : 'no_bids');
    // Pickup location: the originating auction's pickup address, unless the seller supplies a different one now.
    const sellerChose = hasPickupInput(e);
    const loc = sellerChose ? saleLocation.fromInput(e)
      : saleLocation.fromAuction({ street_address: lot.a_street, city: lot.city, address_state: lot.a_state, zip: lot.zip });
    const missing = saleLocation.missingParts(loc);
    // Without a complete pickup location the listing is saved as a DRAFT (never live) and the seller is told why.
    const status = missing.length ? 'draft' : 'active';
    const pv = pickupValues(loc, sellerChose ? 'item' : 'auction');

    const { rows } = await client.query(
      `INSERT INTO marketplace_items
         (seller_id, source_auction_id, source_lot_id, title, description, category, condition, price_cents,
          images, thumbnail_url, city, state, zip, shippable, shipping_cost_cents, shipping_notes, pickup_group,
          status, is_demo, converted_by_user_id, conversion_reason, converted_at,
          pickup_address_line1, pickup_address_line2, pickup_city, pickup_state, pickup_postal_code, pickup_country,
          pickup_location_source, pickup_location_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now(),
               $22,$23,$24,$25,$26,$27,$28, now())
       RETURNING *`,
      [seller.id, lot.auction_id, lotId,
       (e.title || lot.title || 'Item'), (e.description != null ? e.description : lot.description), lot.category, lot.condition,
       price, JSON.stringify(images), lot.thumbnail_url || images[0] || null,
       loc.city || lot.city, loc.state || lot.a_state, loc.postal_code || lot.zip,
       e.shippable != null ? !!e.shippable : !!lot.shippable, lot.shipping_cost_cents, lot.shipping_notes, lot.pickup_group,
       status, !!lot.auction_demo, actingUserId, reason,
       pv.pickup_address_line1, pv.pickup_address_line2, pv.pickup_city, pv.pickup_state, pv.pickup_postal_code, pv.pickup_country,
       pv.pickup_location_source]);
    return { item: rows[0], created: true, needs_pickup_location: missing.length ? missing : undefined };
  });
}

// Direct listing (never auctioned). Server-derives seller from the user.
async function createDirectListing(actingUserId, data = {}) {
  const seller = await sellerForUser(actingUserId);
  if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile for this user.');
  if (!isProfessional(seller.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Marketplace listings are for Professional Sellers.');
  const title = (data.title || '').trim();
  if (!title) throw err(400, 'TITLE_REQUIRED', 'A title is required.');
  const price = Math.max(0, parseInt(data.price_cents, 10) || 0);
  if (!price) throw err(422, 'PRICE_REQUIRED', 'A price is required.');
  const images = Array.isArray(data.images) ? data.images.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 24) : [];
  // Location: the seller's confirmed default storefront location, automatically — unless the seller chose a location
  // for THIS item ("Change Location"). Never inferred from the seller's legal address.
  const status = data.status === 'draft' ? 'draft' : 'active';
  const own = hasPickupInput(data);
  const eff = own ? { address: saleLocation.fromInput(data), source: 'item' } : saleLocation.forItem({ ...seller, pickup_location_source: 'default' });
  const missing = own ? saleLocation.missingParts(eff.address) : (eff.missing || []);
  if (status === 'active' && missing.length) throw pickupRequiredError(missing);
  const loc = own ? eff.address : saleLocation.normalize({});
  const pv = pickupValues(loc, own ? 'item' : 'default');
  const place = publicPlace(eff.address);
  const { rows } = await db.query(
    `INSERT INTO marketplace_items
       (seller_id, title, description, category, condition, price_cents, images, thumbnail_url, city, state, zip,
        shippable, shipping_cost_cents, shipping_notes, pickup_group, status, is_demo, conversion_reason,
        pickup_address_line1, pickup_address_line2, pickup_city, pickup_state, pickup_postal_code, pickup_country,
        pickup_location_source, pickup_location_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'direct',
             $18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
    [seller.id, title, data.description || null, data.category || null, data.condition || null, price,
     JSON.stringify(images), images[0] || null, place.city || data.city || null, place.state || data.state || null, place.zip || data.zip || null,
     !!data.shippable, data.shipping_cost_cents != null ? parseInt(data.shipping_cost_cents, 10) : null,
     data.shipping_notes || null, data.pickup_group || null, status, !!seller.is_demo,
     pv.pickup_address_line1, pv.pickup_address_line2, pv.pickup_city, pv.pickup_state, pv.pickup_postal_code, pv.pickup_country,
     pv.pickup_location_source, new Date()]);
  return rows[0];
}

async function updateItem(id, actingUserId, patch = {}) {
  const seller = await sellerForUser(actingUserId);
  if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  const item = (await db.query('SELECT * FROM marketplace_items WHERE id = $1', [id])).rows[0];
  if (!item) throw err(404, 'NOT_FOUND', 'Listing not found.');
  if (item.seller_id !== seller.id) throw err(403, 'NOT_OWNER', 'Not your listing.');
  const sets = []; const vals = [id]; const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (patch.title != null) add('title', String(patch.title).trim());
  if (patch.description != null) add('description', patch.description);
  if (patch.price_cents != null) add('price_cents', Math.max(0, parseInt(patch.price_cents, 10) || 0));
  if (patch.category != null) add('category', patch.category);
  if (patch.condition != null) add('condition', patch.condition);
  if (patch.shippable != null) add('shippable', !!patch.shippable);
  if (patch.shipping_cost_cents != null) add('shipping_cost_cents', parseInt(patch.shipping_cost_cents, 10));
  if (patch.status != null && ['draft', 'active', 'sold', 'removed'].includes(patch.status)) add('status', patch.status);
  // Location changes affect THIS item only — never the seller's default or any other item.
  let eff = saleLocation.forItem({ ...seller, ...item });
  const locationChanged = hasPickupInput(patch) || patch.use_storefront_location === true;
  if (patch.use_storefront_location === true) {
    const pv = pickupValues(saleLocation.normalize({}), 'default');
    Object.keys(pv).forEach((k) => add(k, pv[k]));
    eff = saleLocation.forItem({ ...seller, pickup_location_source: 'default' });
  } else if (hasPickupInput(patch)) {
    const merged = {};
    PICKUP_COLUMNS.forEach((k) => { merged[k] = patch[k] !== undefined ? patch[k] : item[k]; });
    const loc = saleLocation.fromInput(merged);
    const pv = pickupValues(loc, 'item');
    Object.keys(pv).forEach((k) => add(k, pv[k]));
    eff = { address: loc, source: 'item', missing: saleLocation.missingParts(loc) };
  }
  if (locationChanged) {
    add('pickup_location_updated_at', new Date());
    const place = publicPlace(eff.address);
    if (place.city) add('city', place.city);
    if (place.state) add('state', place.state);
    if (place.zip) add('zip', place.zip);
  }
  // A live item always has a complete pickup location.
  const nextStatus = patch.status != null ? patch.status : item.status;
  if (nextStatus === 'active' && (patch.status === 'active' || locationChanged)) {
    if (eff.missing && eff.missing.length) throw pickupRequiredError(eff.missing);
  }
  if (!sets.length) return item;
  const { rows } = await db.query(`UPDATE marketplace_items SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
  return rows[0];
}

// Seller's own listings (all statuses).
async function listForSeller(sellerId, runner = db) {
  const { rows } = await runner.query(
    `SELECT mi.*, ${DEFAULT_COLUMNS.map((c) => 'sp.' + c).join(', ')}
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.seller_id = $1 ORDER BY mi.created_at DESC`, [sellerId]);
  // The seller sees each item's effective location and where it comes from (their own data; never public).
  return rows.map((r) => {
    const eff = saleLocation.forItem(r);
    const out = Object.assign({}, r);
    DEFAULT_COLUMNS.forEach((k) => { delete out[k]; });
    out.location = { source: eff.source, address: eff.address, missing: eff.missing || [] };
    return out;
  });
}
// Public active listings for a seller (storefront + feed).
async function listPublicForSeller(sellerId, limit = 200, runner = db) {
  const { rows } = await runner.query(
    "SELECT id, seller_id, title, price_cents, thumbnail_url, images, city, state, shippable, pickup_group, category, condition, status, source_lot_id, created_at FROM marketplace_items WHERE seller_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT $2",
    [sellerId, limit]);
  return rows;
}
async function getPublicItem(id, runner = db) {
  // Public statuses: 'active' (purchasable), 'pending_purchase' (temporarily held during a checkout),
  // and 'sold' (shown as SOLD). 'draft'/'removed' remain non-public (404). The item page reads status
  // to decide Buy Now vs. SOLD vs. temporarily-unavailable.
  const { rows } = await runner.query(
    `SELECT mi.*, sp.storefront_slug, sp.seller_type, sp.show_branding_to_buyers,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.id = $1 AND mi.status IN ('active','pending_purchase','sold')`, [id]);
  return rows[0] ? publicItem(rows[0]) : null;
}
// Public shape of an item — an ALLOW-LIST, so a column added later is private until someone deliberately publishes it.
// Location: city/state only (never the pickup street, unit, ZIP or the seller's default location). No internal ids
// (seller, source auction/lot, converting user, pending order). Seller name only when the seller's branding is public.
const PUBLIC_ITEM_FIELDS = ['id', 'title', 'description', 'category', 'condition', 'price_cents', 'images', 'thumbnail_url',
  'city', 'state', 'shippable', 'shipping_cost_cents', 'shipping_notes', 'status', 'created_at', 'storefront_slug'];
function publicItem(row) {
  const out = {};
  PUBLIC_ITEM_FIELDS.forEach((k) => { if (row[k] !== undefined) out[k] = row[k]; });
  out.source_lot_id = row.source_lot_id ? true : null;          // the page only needs "previously at auction"
  const branded = row.seller_type === undefined ? true : brandingVisible(row.seller_type, row.show_branding_to_buyers);
  out.seller_name = branded ? (row.seller_name || null) : null;
  if (!branded) out.storefront_slug = null;
  return out;
}
// For the closed-lot "now in Marketplace" banner.
async function listingForLot(lotId, runner = db) {
  const { rows } = await runner.query("SELECT id FROM marketplace_items WHERE source_lot_id = $1 AND status = 'active'", [lotId]);
  return rows[0] || null;
}

module.exports = {
  sellerForUser, listUnsoldEligible, convertLotToListing, createDirectListing, updateItem,
  listForSeller, listPublicForSeller, getPublicItem, listingForLot, defaultPrice, UNSOLD_JOIN,
  publicItem, PICKUP_COLUMNS,
};
