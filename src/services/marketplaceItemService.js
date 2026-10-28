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
 * Checkout (Buy Now) lives in marketplaceOrderService and is gated by MARKETPLACE_CHECKOUT_ENABLED; while it is off a
 * listing is a public, priced inventory record with a "contact seller" path.
 *
 * Inventory safety (storefront milestone 1): an item a buyer has reserved (checkout hold) or bought cannot be changed by
 * the seller - no price, title, shipping, location or status change - and a sold item can never be put back on sale.
 */

const db = require('../db');
const sellerActor = require('../lib/sellerActor');
const productData = require('../lib/productData');
const shipping = require('../lib/storefrontShipping');
const { withTransaction } = require('../utils/withTransaction');
// Storefronts are a Professional Seller feature (owner decision 2026-10-12): eligibility uses the canonical seller-type rule,
// never the buyer-branding list (which also includes the self-serve 'business' Individual Seller type).
const { brandingVisible } = require('../lib/sellerBranding');
const { isProfessional } = require('./sellerTypeRules');
const { PROFESSIONAL_SELLER_TYPES } = require('../constants/sellerTypes');
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

// The seller's own inventory number / SKU (migration 204): optional, trimmed, ≤ 64 printable characters. Unique within the
// seller's live items (database); another seller may use the same number.
function normalizeInventoryNumber(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u2060\ufeff]+/g, '').trim();
  if (!s) return null;
  if (s.length > 64) throw err(422, 'INVENTORY_NUMBER_INVALID', 'Inventory numbers can be up to 64 characters.');
  return s;
}
function inventoryConflict(e) {
  if (e && e.code === '23505' && /inventory_number/.test(String(e.constraint || e.message || ''))) {
    throw err(409, 'INVENTORY_NUMBER_TAKEN', 'You already have a listing with that inventory number.');
  }
  throw e;
}

// Resolve the acting seller company (id, seller_type, is_demo, city/state via profile). Null if none. Accepts the seller
// context from the seller checkpoint (owner or staff; company from the session) or the owner's user id.
async function sellerForUser(actor, runner = db) {
  return sellerActor.sellerRow(actor, runner, `id, user_id, seller_type, is_demo, unsold_price_policy, shipping_defaults, ${DEFAULT_COLUMNS.join(', ')}`);
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

    // Idempotency: already converted → return the existing listing (repeat clicks are safe) — but ONLY to its own seller.
    // Another seller naming this lot id learns nothing (same answer as a lot that does not exist).
    const existing = (await client.query('SELECT * FROM marketplace_items WHERE source_lot_id = $1', [lotId])).rows[0];
    if (existing && existing.seller_id !== seller.id) throw err(404, 'LOT_NOT_FOUND', 'Lot not found or not owned by you.');
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
       // Owner rule: a converted auction lot always starts PICKUP ONLY, whatever the lot's auction shipping settings were;
       // the seller turns shipping on for the listing deliberately, with complete shipping terms.
       false, null, null, lot.pickup_group,
       status, !!lot.auction_demo, sellerActor.actorUserId(actingUserId), reason,
       pv.pickup_address_line1, pv.pickup_address_line2, pv.pickup_city, pv.pickup_state, pv.pickup_postal_code, pv.pickup_country,
       pv.pickup_location_source]);
    return { item: rows[0], created: true, needs_pickup_location: missing.length ? missing : undefined };
  });
}

// Direct listing (never auctioned). Server-derives seller from the user.
// opts.importBatchId / opts.importRow (bulk import, migration 207): the import row that creates this item, recorded in the
// same INSERT so a retried import can never create the item twice (unique per batch row).
async function createDirectListing(actingUserId, data = {}, opts = {}) {
  const seller = await sellerForUser(actingUserId);
  if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile for this user.');
  if (!isProfessional(seller.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Marketplace listings are for Professional Sellers.');
  const title = (data.title || '').trim();
  if (!title) throw err(400, 'TITLE_REQUIRED', 'A title is required.');
  const price = Math.max(0, parseInt(data.price_cents, 10) || 0);
  if (!price) throw err(422, 'PRICE_REQUIRED', 'A price is required.');
  const images = Array.isArray(data.images) ? data.images.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 24) : [];
  // Optional product details (brand, barcode, part number, condition type, era, material, photo descriptions): only
  // what the seller actually entered; an invalid barcode is refused, never corrected (src/lib/productData.js).
  const pd = productData.normalizeProductFields(data);
  const inventoryNumber = normalizeInventoryNumber(data.inventory_number);
  // Shipping: OFF unless the seller turns it on for this item with complete terms, or deliberately applies their store
  // shipping default (src/lib/storefrontShipping.js). A blank shipping price is never free.
  const fromDefaults = data.apply_store_shipping_defaults === true ? shipping.columnsFromStoreDefaults(seller.shipping_defaults) : null;
  if (data.apply_store_shipping_defaults === true && !fromDefaults) throw err(422, 'NO_STORE_SHIPPING_DEFAULT', 'Your store has no shipping default turned on.');
  const sh = { shippable: false, shipping_method: null, shipping_price_mode: null, shipping_cost_cents: null, shipping_destinations: null,
    shipping_states: [], handling_days: null, is_oversized: false, is_fragile: false, shipping_notes: null,
    ...(fromDefaults || shipping.normalizeShippingInput({ ...data, shippable: data.shippable === true }, {})) };
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
  // Only an import names these columns (migration 207), so ordinary listings never depend on that migration.
  const importCols = opts.importBatchId ? ', import_batch_id, import_row' : '';
  const importVals = opts.importBatchId ? ',$42,$43' : '';
  const { rows } = await db.query(
    `INSERT INTO marketplace_items
       (seller_id, title, description, category, condition, price_cents, images, thumbnail_url, city, state, zip,
        shippable, shipping_cost_cents, shipping_notes, pickup_group, status, is_demo, conversion_reason,
        pickup_address_line1, pickup_address_line2, pickup_city, pickup_state, pickup_postal_code, pickup_country,
        pickup_location_source, pickup_location_updated_at,
        brand, manufacturer, gtin, mpn, condition_type, era_or_period, material, image_alt,
        shipping_method, shipping_price_mode, shipping_destinations, shipping_states, handling_days, is_oversized, is_fragile, inventory_number${importCols})
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'direct',
             $18,$19,$20,$21,$22,$23,$24,$25, $26,$27,$28,$29,$30,$31,$32,$33::jsonb,
             $34,$35,$36,$37,$38,$39,$40,$41${importVals}) RETURNING *`,
    [seller.id, title, data.description || null, data.category || null, data.condition || null, price,
     JSON.stringify(images), images[0] || null, place.city || data.city || null, place.state || data.state || null, place.zip || data.zip || null,
     sh.shippable, sh.shipping_cost_cents, sh.shipping_notes, data.pickup_group || null, status, !!seller.is_demo,
     pv.pickup_address_line1, pv.pickup_address_line2, pv.pickup_city, pv.pickup_state, pv.pickup_postal_code, pv.pickup_country,
     pv.pickup_location_source, new Date(),
     pd.brand || null, pd.manufacturer || null, pd.gtin || null, pd.mpn || null, pd.condition_type || null, pd.era_or_period || null,
     pd.material || null, JSON.stringify(pd.image_alt || []),
     sh.shipping_method, sh.shipping_price_mode, sh.shipping_destinations, sh.shipping_states || [], sh.handling_days, !!sh.is_oversized, !!sh.is_fragile,
     inventoryNumber || null, ...(opts.importBatchId ? [opts.importBatchId, opts.importRow] : [])]).catch(inventoryConflict);
  return rows[0];
}

// Status changes a seller may make. 'pending_purchase' is set only by checkout; 'sold' may be set by the seller for an
// item sold elsewhere (and by a paid order); a sold item may only be removed from view.
// 'paused' (migration 207): a published item taken off sale for now; not public, details and photos kept.
const SELLER_TRANSITIONS = {
  draft: ['draft', 'active', 'removed', 'sold'],
  active: ['active', 'draft', 'paused', 'removed', 'sold'],
  paused: ['paused', 'active', 'draft', 'removed', 'sold'],
  removed: ['removed', 'draft', 'active'],
  sold: ['sold', 'removed'],
  pending_purchase: [],
};

async function updateItem(id, actingUserId, patch = {}) {
  const seller = await sellerForUser(actingUserId);
  if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  if (!isProfessional(seller.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Marketplace listings are for Professional Sellers.');
  return withTransaction(async (client) => {
  // Locked: checkout claims the same row FOR UPDATE, so an edit and a purchase can never interleave.
  const item = (await client.query('SELECT * FROM marketplace_items WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!item) throw err(404, 'NOT_FOUND', 'Listing not found.');
  if (item.seller_id !== seller.id) throw err(403, 'NOT_OWNER', 'Not your listing.');
  const orders = (await client.query(
    `SELECT count(*) FILTER (WHERE payment_status IN ('pending','processing'))::int AS live,
            count(*) FILTER (WHERE payment_status = 'paid')::int AS paid
       FROM marketplace_orders WHERE marketplace_item_id = $1`, [id])).rows[0] || { live: 0, paid: 0 };
  if (item.status === 'pending_purchase' || orders.live > 0) {
    throw err(409, 'ITEM_RESERVED', "A buyer is checking out this item, so it can't be changed right now. Try again in a few minutes.");
  }
  if (patch.status != null) {
    if (!['draft', 'active', 'paused', 'sold', 'removed'].includes(patch.status)) throw err(400, 'INVALID_STATUS', 'That status is not available.');
    // A listing an administrator took down stays down until an administrator restores it (database-enforced too).
    if (item.moderation_status === 'taken_down' && patch.status !== item.status) {
      throw err(409, 'TAKEN_DOWN', 'This listing was removed by Advantage.Bid and cannot be put back on sale. Contact support if you have questions.');
    }
    const allowed = SELLER_TRANSITIONS[item.status] || [];
    if (!allowed.includes(patch.status) || (orders.paid > 0 && ['draft', 'active', 'paused'].includes(patch.status))) {
      throw err(409, 'ITEM_SOLD', 'This item has been sold. It can be removed from view but not offered again.');
    }
  }
  // The seller's choice to show a sold item's realized price to signed-in members may be changed at any time.
  if ((item.status === 'sold' || orders.paid > 0) && Object.keys(patch).some((k) => k !== 'status' && k !== 'show_realized_price_to_members' && patch[k] !== undefined)) {
    throw err(409, 'ITEM_SOLD', 'This item has been sold, so its details are kept as they were at the sale.');
  }
  const sets = []; const vals = [id]; const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (patch.title != null) add('title', String(patch.title).trim());
  if (patch.description != null) add('description', patch.description);
  if (patch.price_cents != null) add('price_cents', Math.max(0, parseInt(patch.price_cents, 10) || 0));
  if (patch.category != null) add('category', patch.category);
  if (patch.condition != null) add('condition', patch.condition);
  // Shipping settings: validated against the item's current terms (src/lib/storefrontShipping.js); turning shipping on
  // needs complete terms, and a blank price is never free. Only this item changes — never other listings.
  for (const [k, v] of Object.entries(shipping.normalizeShippingInput(patch, item))) add(k, v);
  if (patch.status != null) add('status', patch.status);
  for (const [k, v] of Object.entries(productData.normalizeProductFields(patch))) add(k, k === 'image_alt' ? JSON.stringify(v) : v);
  if (patch.inventory_number !== undefined) add('inventory_number', normalizeInventoryNumber(patch.inventory_number));
  if (patch.show_realized_price_to_members !== undefined) {
    // Disclosing a sale price is the company owner's decision, never a staff role's.
    if (actingUserId && typeof actingUserId === 'object' && actingUserId.staff) throw err(403, 'OWNER_ONLY', 'Only the company owner can change who sees sale prices.');
    if (typeof patch.show_realized_price_to_members !== 'boolean') throw err(422, 'INVALID_SETTING', 'Choose whether to show the sale price.');
    add('show_realized_price_to_members', patch.show_realized_price_to_members);
  }
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
  const { rows } = await client.query(`UPDATE marketplace_items SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals).catch(inventoryConflict);
  return rows[0];
  });
}

// ── Photos (migration 207) ──────────────────────────────────────────────────────────────────────────────────────────
const MAX_PHOTOS = 24;
// Lock the seller's own item for a photo change. A sold or reserved item keeps the photos it had at the sale.
async function lockOwnItemForPhotos(client, itemId, sellerId) {
  const item = (await client.query('SELECT * FROM marketplace_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
  if (!item || item.seller_id !== sellerId) throw err(404, 'NOT_FOUND', 'Listing not found.');
  if (item.status === 'sold' || item.status === 'pending_purchase') throw err(409, 'ITEM_SOLD', 'This item has been sold or is being purchased, so its photos are kept as they were.');
  // The same protections as editing the item (updateItem): an administrator takedown, a sale or a checkout in progress
  // keeps the photos exactly as they are, whatever the item's status now says.
  if (item.moderation_status === 'taken_down') throw err(409, 'TAKEN_DOWN', 'This listing was removed by Advantage.Bid, so its photos cannot be changed.');
  const o = (await client.query(
    `SELECT count(*) FILTER (WHERE payment_status IN ('pending','processing'))::int AS live,
            count(*) FILTER (WHERE payment_status = 'paid')::int AS paid
       FROM marketplace_orders WHERE marketplace_item_id = $1`, [itemId])).rows[0] || { live: 0, paid: 0 };
  if (o.paid > 0) throw err(409, 'ITEM_SOLD', 'This item has been sold, so its photos are kept as they were at the sale.');
  if (o.live > 0) throw err(409, 'ITEM_RESERVED', "A buyer is checking out this item, so it can't be changed right now. Try again in a few minutes.");
  return item;
}
const imagesOf = (item) => (Array.isArray(item.images) ? item.images.filter((u) => typeof u === 'string') : []);

// Append uploaded photos (already stored; https URLs) to the seller's own item, in order, up to the photo limit.
// Returns { item, added, skipped_full }. Internal: callers have already resolved and checked the seller.
async function appendPhotos(itemId, sellerId, urls, runner = null) {
  const run = async (client) => {
    const item = await lockOwnItemForPhotos(client, itemId, sellerId);
    const current = imagesOf(item);
    const room = Math.max(0, MAX_PHOTOS - current.length);
    const fresh = urls.filter((u) => typeof u === 'string' && /^https:\/\//i.test(u) && !current.includes(u));
    const add = fresh.slice(0, room);
    if (!add.length) return { item, added: 0, skipped_full: fresh.length };
    const images = current.concat(add);
    const row = (await client.query(
      `UPDATE marketplace_items SET images = $2::jsonb, thumbnail_url = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [itemId, JSON.stringify(images), images[0]])).rows[0];
    return { item: row, added: add.length, skipped_full: fresh.length - add.length };
  };
  return runner ? run(runner) : withTransaction(run);
}

// Reorder, choose the primary (first) photo, or remove photos. The new list must be made only of the item's current
// photos (no outside URL can be attached this way); photo descriptions move with their photos.
async function setItemPhotos(itemId, actingUserId, images) {
  const seller = await sellerForUser(actingUserId);
  if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  if (!isProfessional(seller.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Marketplace listings are for Professional Sellers.');
  if (!Array.isArray(images) || images.some((u) => typeof u !== 'string')) throw err(422, 'PHOTOS_INVALID', 'Send the photos as a list.');
  return withTransaction(async (client) => {
    const item = await lockOwnItemForPhotos(client, itemId, seller.id);
    const current = imagesOf(item);
    if (images.length !== new Set(images).size || images.some((u) => !current.includes(u))) {
      throw err(422, 'PHOTOS_INVALID', "Only this item's own photos can be arranged here.");
    }
    const alts = Array.isArray(item.image_alt) ? item.image_alt : [];
    const altFor = (u) => alts[current.indexOf(u)] || '';
    const row = (await client.query(
      `UPDATE marketplace_items SET images = $2::jsonb, image_alt = $3::jsonb, thumbnail_url = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [itemId, JSON.stringify(images), JSON.stringify(images.map(altFor)), images[0] || null])).rows[0];
    // A removed photo's upload record goes too, so the seller can add that photo again later.
    const removed = current.filter((u) => !images.includes(u));
    if (removed.length) await client.query('DELETE FROM storefront_item_photos WHERE item_id = $1 AND url = ANY($2::text[])', [itemId, removed]);
    return row;
  });
}

// Seller's own listings (all statuses).
async function listForSeller(sellerId, runner = db, { streetAddress = true, q = null } = {}) {
  // Optional search by the seller's inventory number or title (within this seller's own items only).
  const term = q == null ? null : String(q).trim().slice(0, 100);
  const like = term ? '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%' : null;
  const { rows } = await runner.query(
    `SELECT mi.*, ${DEFAULT_COLUMNS.map((c) => 'sp.' + c).join(', ')}
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.seller_id = $1 AND ($2::text IS NULL OR mi.inventory_number ILIKE $2 OR mi.title ILIKE $2)
      ORDER BY mi.created_at DESC`, [sellerId, like]);
  // The seller sees each item's effective location and where it comes from (their own data; never public).
  return rows.map((r) => {
    const eff = saleLocation.forItem(r);
    const out = Object.assign({}, r);
    DEFAULT_COLUMNS.forEach((k) => { delete out[k]; });
    out.location = { source: eff.source, address: eff.address, missing: eff.missing || [] };
    return streetAddress ? out : staffItemView(out);
  });
}
// A staff member's view of one of the company's items: the private pickup street address stays with the owner
// (city/state only), and no internal user or order ids. Used for every item response sent to staff.
function staffItemView(row) {
  if (!row) return row;
  const out = Object.assign({}, row);
  PICKUP_COLUMNS.filter((k) => !['pickup_city', 'pickup_state'].includes(k)).forEach((k) => { delete out[k]; });
  DEFAULT_COLUMNS.forEach((k) => { delete out[k]; });
  delete out.converted_by_user_id; delete out.pending_order_id; delete out.zip;
  if (out.location) out.location = { ...out.location, address: out.location.address ? { city: out.location.address.city || null, state: out.location.address.state || null } : null };
  return out;
}

// Public active listings for a seller (storefront + feed).
// opts.excludeDemoItems: also leave out demo-flagged items (the website widget for a real seller, so it matches the
// canonical live-item rule in marketplaceVisibility.activeMarketplaceItemSql).
async function listPublicForSeller(sellerId, limit = 200, runner = db, { excludeDemoItems = false } = {}) {
  const { rows } = await runner.query(
    `SELECT mi.id, mi.seller_id, mi.title, mi.price_cents, mi.thumbnail_url, mi.images, mi.city, mi.state, mi.shippable, mi.pickup_group,
            mi.category, mi.condition, mi.status, mi.source_lot_id, mi.created_at,
            mi.shipping_method, mi.shipping_price_mode, mi.shipping_cost_cents, mi.shipping_destinations, mi.shipping_states
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.seller_id = $1 AND mi.status = 'active' AND sp.seller_type = ANY($3::text[])${excludeDemoItems ? ' AND mi.is_demo IS NOT TRUE' : ''}
      ORDER BY mi.created_at DESC LIMIT $2`,
    [sellerId, limit, PROFESSIONAL_SELLER_TYPES]);
  // "Ships" only when shipping can actually be bought (complete terms); the shipping terms themselves stay on the item page.
  return rows.map((r) => {
    const { shipping_method, shipping_price_mode, shipping_cost_cents, shipping_destinations, shipping_states, ...rest } = r;
    return { ...rest, shippable: shipping.shippingOffer(r).available };
  });
}
// opts.viewerUserId: the signed-in Advantage.Bid member viewing the page (null = public). A sold item's realized price is
// added ONLY for a signed-in member AND only when the seller chose to show it (show_realized_price_to_members).
async function getPublicItem(id, runner = db, { viewerUserId = null } = {}) {
  // Public statuses: 'active' (purchasable), 'pending_purchase' (temporarily held during a checkout),
  // and 'sold' (shown as SOLD). 'draft'/'removed' remain non-public (404). The item page reads status
  // to decide Buy Now vs. SOLD vs. temporarily-unavailable.
  const { rows } = await runner.query(
    `SELECT mi.*, sp.storefront_slug, sp.seller_type, sp.show_branding_to_buyers,
            COALESCE(sp.display_name, sp.metadata->>'display_name', sp.metadata->>'business_name') AS seller_name,
            (SELECT array_agg(v.kind) FROM seller_policy_versions v WHERE v.seller_id = mi.seller_id AND v.status = 'published') AS published_policy_kinds,
            (SELECT json_object_agg(v.kind, v.version) FROM seller_policy_versions v WHERE v.seller_id = mi.seller_id AND v.status = 'published') AS published_policy_versions
       FROM marketplace_items mi JOIN seller_profiles sp ON sp.id = mi.seller_id
      WHERE mi.id = $1 AND mi.status IN ('active','pending_purchase','sold') AND sp.seller_type = ANY($2::text[])`, [id, PROFESSIONAL_SELLER_TYPES]);   // Professional Sellers only
  if (!rows[0]) return null;
  const out = publicItem(rows[0]);
  // Whether "Ask the seller a question" is offered on this item to this viewer (general switch, or the controlled pilot).
  out.questions_enabled = ['active', 'pending_purchase'].includes(out.status)
    && require('../lib/launchGuards').storefrontMessagingAllowed({ sellerId: rows[0].seller_id, userId: viewerUserId, side: 'buyer' });
  if (out.status === 'sold' && viewerUserId && rows[0].show_realized_price_to_members === true) {
    const realized = await realizedSalePrice(rows[0].id, runner);
    if (realized != null) { out.realized_price_cents = realized; out.realized_price_label = 'Fixed-price sale'; }
  }
  return out;
}
// The item price actually paid on the item's paid, never-refunded order (never shipping, tax or fees). Null otherwise.
async function realizedSalePrice(itemId, runner = db) {
  const r = (await runner.query(
    `SELECT item_price_cents FROM marketplace_orders WHERE marketplace_item_id = $1 AND payment_status = 'paid' AND refund_status = 'none'
      ORDER BY paid_at DESC NULLS LAST LIMIT 1`, [itemId])).rows[0];
  return r ? Number(r.item_price_cents) : null;
}
// Public shape of an item — an ALLOW-LIST, so a column added later is private until someone deliberately publishes it.
// Location: city/state only (never the pickup street, unit, ZIP or the seller's default location). No internal ids
// (seller, source auction/lot, converting user, pending order). Seller name only when the seller's branding is public.
const PUBLIC_ITEM_FIELDS = ['id', 'title', 'description', 'category', 'condition', 'price_cents', 'images', 'thumbnail_url',
  'city', 'state', 'shippable', 'shipping_cost_cents', 'shipping_notes', 'status', 'created_at', 'updated_at', 'storefront_slug',
  // product data the seller chose to give (migration 200) — public by nature; never invented
  'brand', 'manufacturer', 'gtin', 'mpn', 'condition_type', 'era_or_period', 'material', 'image_alt',
  // seller-set shipping terms (migration 201) — public by nature
  'shipping_method', 'shipping_price_mode', 'shipping_destinations', 'shipping_states', 'handling_days', 'is_oversized', 'is_fragile'];
function publicItem(row) {
  const out = {};
  PUBLIC_ITEM_FIELDS.forEach((k) => { if (row[k] !== undefined) out[k] = row[k]; });
  out.source_lot_id = row.source_lot_id ? true : null;          // the page only needs "previously at auction"
  // What a buyer can actually get (pickup always; shipping only with complete terms). `shippable` means "can be shipped".
  out.shipping = shipping.publicShipping(row);
  out.shippable = !!out.shipping.shipping;
  out.shipping_cost_cents = out.shipping.shipping ? out.shipping.shipping.shipping_cents : null;
  const branded = row.seller_type === undefined ? true : brandingVisible(row.seller_type, row.show_branding_to_buyers);
  out.seller_name = branded ? (row.seller_name || null) : null;
  if (!branded) out.storefront_slug = null;
  // Which of THIS item's seller's policies are published (links go to that seller's own policy pages, never another's).
  // Hidden branding: the seller's policies cannot be linked without revealing the seller, so none are shown (or applied).
  const kinds = branded && Array.isArray(row.published_policy_kinds) ? row.published_policy_kinds : [];
  out.policies = { store_terms: kinds.includes('store_terms'), shipping_pickup: kinds.includes('shipping_pickup') };
  const vers = branded && row.published_policy_versions && typeof row.published_policy_versions === 'object' ? row.published_policy_versions : {};
  out.policy_versions = { store_terms: vers.store_terms || null, shipping_pickup: vers.shipping_pickup || null };
  // Sold-item price privacy (owner decision 2026-10-26, roadmap §12.3): once an item has SOLD, no public output carries
  // its price or shipping charge — a fixed-price item sells at its listed price, so showing it would disclose the sale
  // price. Every public surface (JSON API, server-rendered page, structured data) is built from this shape. The seller's
  // own tools read the full record; signed-in members may see the realized price only by the seller's choice
  // (getPublicItem). A pending checkout is not a sale and keeps its price.
  if (out.status === 'sold') {
    out.price_cents = null; out.shipping_cost_cents = null; out.shipping_price_mode = null;
    out.shipping = { pickup: false, pickup_only: false, shipping: null, summary: 'This item has sold.', oversized: out.shipping.oversized, fragile: out.shipping.fragile };
    out.shippable = false;
    out.price_hidden = true;
  }
  return out;
}
// For the closed-lot "now in Marketplace" banner.
async function listingForLot(lotId, runner = db) {
  const { rows } = await runner.query("SELECT id FROM marketplace_items WHERE source_lot_id = $1 AND status = 'active'", [lotId]);
  return rows[0] || null;
}

module.exports = {
  appendPhotos, setItemPhotos, MAX_PHOTOS, SELLER_TRANSITIONS, _normalizeInventoryNumber: normalizeInventoryNumber,
  sellerForUser, listUnsoldEligible, convertLotToListing, createDirectListing, updateItem,
  listForSeller, listPublicForSeller, getPublicItem, realizedSalePrice, listingForLot, defaultPrice, UNSOLD_JOIN,
  publicItem, PICKUP_COLUMNS, staffItemView,
};
