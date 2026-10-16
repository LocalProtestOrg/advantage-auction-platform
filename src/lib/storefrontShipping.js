'use strict';

/**
 * storefrontShipping.js — the ONE place that decides whether, where and for how much a Professional Storefront item can
 * be shipped (owner requirements 2026-10-16; roadmap §7.1; migration 201). Used by checkout, the item page, structured
 * data and (later) the storefront widget and shopping feeds, so they can never disagree.
 *
 * Rules:
 *   • Shipping is OFF unless the seller turned it on for the item (store default and item default are both "no").
 *   • An item offered for shipping needs a supported method, the places it ships to, and a price that is either a set
 *     amount (> $0) or a deliberate "free shipping" choice. A blank or missing price is NEVER free: shipping checkout is
 *     refused until the seller completes it. Local pickup is always available.
 *   • Items listed before migration 201 with a set shipping price keep that price; without a method or destinations they
 *     cannot be shipped until the seller completes the details (the listing itself is not changed).
 *   • The seller fee is never computed here: it stays on the item price only (shipping and tax are outside the fee base).
 * Pure (no DB).
 */

const METHODS = { parcel: 'Parcel shipping', freight: 'Freight shipping', white_glove: 'White-glove delivery', local_delivery: 'Local delivery' };
const DESTINATIONS = { us_contiguous: 'the contiguous United States', us_all: 'anywhere in the United States', listed_states: 'selected states' };
const PRICE_MODES = ['flat', 'free'];
const NON_CONTIGUOUS = new Set(['AK', 'HI', 'PR', 'VI', 'GU', 'AS', 'MP']);
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP'.split(' '));
const MAX_HANDLING_DAYS = 60;
const MAX_SHIPPING_CENTS = 10000000;   // $100,000 — a sanity bound, not a pricing rule

function err(code, message, status = 422) { const e = new Error(message); e.status = status; e.code = code; return e; }
const clip = (v, n) => (v == null ? null : (String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) || null));

/**
 * What the buyer can actually get. { available, reason?, method, method_label, price_mode, shipping_cents, destinations,
 * states, handling_days, oversized, fragile, notes }. reason: PICKUP_ONLY | SHIPPING_DETAILS_INCOMPLETE.
 */
function shippingOffer(item) {
  const base = { oversized: !!item.is_oversized, fragile: !!item.is_fragile, notes: item.shipping_notes || null };
  if (!item.shippable) return { available: false, reason: 'PICKUP_ONLY', ...base };
  const method = METHODS[item.shipping_method] ? item.shipping_method : null;
  const dest = DESTINATIONS[item.shipping_destinations] ? item.shipping_destinations : null;
  const states = Array.isArray(item.shipping_states) ? item.shipping_states.filter((s) => US_STATES.has(s)) : [];
  const cost = item.shipping_cost_cents == null ? null : Number(item.shipping_cost_cents);
  let cents = null;
  if (item.shipping_price_mode === 'free') cents = 0;
  else if ((item.shipping_price_mode === 'flat' || item.shipping_price_mode == null) && Number.isInteger(cost) && cost > 0) cents = cost;
  const complete = method && dest && cents !== null && (dest !== 'listed_states' || states.length > 0);
  if (!complete) return { available: false, reason: 'SHIPPING_DETAILS_INCOMPLETE', ...base };
  return { available: true, method, method_label: METHODS[method], price_mode: cents === 0 ? 'free' : 'flat', shipping_cents: cents,
    destinations: dest, states: dest === 'listed_states' ? states : [], handling_days: Number.isInteger(item.handling_days) ? item.handling_days : null, ...base };
}

function destinationAllowed(offer, state) {
  const st = String(state || '').toUpperCase();
  if (!offer || !offer.available || !US_STATES.has(st)) return false;
  if (offer.destinations === 'us_all') return true;
  if (offer.destinations === 'us_contiguous') return !NON_CONTIGUOUS.has(st);
  return offer.states.includes(st);
}

/**
 * The shipping charge for a purchase, or a refusal. Never returns $0 unless the seller chose free shipping.
 * method 'pickup' → 0. Throws 422 SHIPPING_UNAVAILABLE / SHIPPING_DETAILS_INCOMPLETE / SHIPPING_DESTINATION_NOT_SERVED.
 */
function shippingChargeFor(item, method, shipToState) {
  if (method !== 'shipping') return { shippingCents: 0, offer: shippingOffer(item) };
  const offer = shippingOffer(item);
  if (offer.reason === 'PICKUP_ONLY') throw err('SHIPPING_UNAVAILABLE', 'This item is pickup only.');
  if (!offer.available) throw err('SHIPPING_DETAILS_INCOMPLETE', 'Shipping is not available for this item yet. Choose local pickup or ask the seller.');
  if (shipToState !== undefined && !destinationAllowed(offer, shipToState)) {
    throw err('SHIPPING_DESTINATION_NOT_SERVED', 'The seller does not ship this item to that location. Choose local pickup or another address.');
  }
  return { shippingCents: offer.shipping_cents, offer };
}

/**
 * Validate the seller's shipping settings for an item (or the store default). Returns the item columns to write, only for
 * keys sent. Turning shipping on requires complete details; turning it off (pickup only) clears nothing else.
 * `current` = the item's existing values (for a partial update); the merged result is what is validated.
 */
function normalizeShippingInput(input = {}, current = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  const out = {};
  if (has('shippable')) out.shippable = input.shippable === true || input.shippable === 'true';
  if (has('shipping_method')) {
    const m = input.shipping_method == null || input.shipping_method === '' ? null : String(input.shipping_method);
    if (m !== null && !METHODS[m]) throw err('SHIPPING_METHOD_INVALID', 'Choose a shipping method from the list.');
    out.shipping_method = m;
  }
  if (has('shipping_price_mode')) {
    const p = input.shipping_price_mode == null || input.shipping_price_mode === '' ? null : String(input.shipping_price_mode);
    if (p !== null && !PRICE_MODES.includes(p)) throw err('SHIPPING_PRICE_MODE_INVALID', 'Choose a shipping price or free shipping.');
    out.shipping_price_mode = p;
  }
  if (has('shipping_cost_cents')) {
    const v = input.shipping_cost_cents;
    if (v == null || v === '') out.shipping_cost_cents = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > MAX_SHIPPING_CENTS) throw err('SHIPPING_PRICE_INVALID', 'Enter the shipping price in dollars and cents.');
      out.shipping_cost_cents = n;
    }
  }
  if (has('shipping_destinations')) {
    const d = input.shipping_destinations == null || input.shipping_destinations === '' ? null : String(input.shipping_destinations);
    if (d !== null && !DESTINATIONS[d]) throw err('SHIPPING_DESTINATIONS_INVALID', 'Choose where this item can be shipped.');
    out.shipping_destinations = d;
  }
  if (has('shipping_states')) {
    const list = Array.isArray(input.shipping_states) ? input.shipping_states : String(input.shipping_states || '').split(/[\s,]+/);
    const states = [...new Set(list.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean))];
    const bad = states.filter((x) => !US_STATES.has(x));
    if (bad.length) throw err('SHIPPING_STATES_INVALID', `These are not US state codes: ${bad.slice(0, 5).join(', ')}.`);
    out.shipping_states = states;
  }
  if (has('handling_days')) {
    const v = input.handling_days;
    if (v == null || v === '') out.handling_days = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > MAX_HANDLING_DAYS) throw err('HANDLING_DAYS_INVALID', `Handling time must be 0 to ${MAX_HANDLING_DAYS} business days.`);
      out.handling_days = n;
    }
  }
  if (has('is_oversized')) out.is_oversized = input.is_oversized === true || input.is_oversized === 'true';
  if (has('is_fragile')) out.is_fragile = input.is_fragile === true || input.is_fragile === 'true';
  if (has('shipping_notes')) out.shipping_notes = clip(input.shipping_notes, 1000);

  if (!Object.keys(out).length) return out;   // nothing about shipping was sent: nothing to change or validate
  // Free shipping is a deliberate choice and carries no price; a price is never kept alongside it.
  if ({ ...current, ...out }.shipping_price_mode === 'free' && { ...current, ...out }.shipping_cost_cents != null) out.shipping_cost_cents = null;
  const merged = { ...current, ...out };
  if (merged.shippable) {
    const m2 = merged;
    if (!METHODS[m2.shipping_method]) throw err('SHIPPING_METHOD_REQUIRED', 'Choose how this item will be shipped.');
    if (!DESTINATIONS[m2.shipping_destinations]) throw err('SHIPPING_DESTINATIONS_REQUIRED', 'Choose where this item can be shipped.');
    if (m2.shipping_destinations === 'listed_states' && !(Array.isArray(m2.shipping_states) && m2.shipping_states.length)) {
      throw err('SHIPPING_STATES_REQUIRED', 'List the states this item can be shipped to.');
    }
    if (m2.shipping_price_mode === 'free') { /* deliberate free shipping */ } else if (m2.shipping_price_mode === 'flat' || m2.shipping_price_mode == null) {
      if (!(Number.isInteger(Number(m2.shipping_cost_cents)) && Number(m2.shipping_cost_cents) > 0)) {
        throw err('SHIPPING_PRICE_REQUIRED', 'Enter the shipping price, or choose free shipping. A blank price is never treated as free.');
      }
      if (m2.shipping_price_mode == null) out.shipping_price_mode = 'flat';
    }
  }
  return out;
}

/** Validate a store-wide shipping default. Stored on the seller organisation; applied only to NEW items, and only when the
 *  seller deliberately chooses it. Returns the JSON to store. */
function normalizeStoreDefaults(input = {}) {
  const enabled = input.enabled === true || input.enabled === 'true';
  if (!enabled) return { enabled: false };
  const cols = normalizeShippingInput({ ...input, shippable: true }, {});
  return { enabled: true, shipping_method: cols.shipping_method, shipping_price_mode: cols.shipping_price_mode || 'flat',
    shipping_cost_cents: cols.shipping_price_mode === 'free' ? null : cols.shipping_cost_cents, shipping_destinations: cols.shipping_destinations,
    shipping_states: cols.shipping_states || [], handling_days: cols.handling_days == null ? null : cols.handling_days,
    is_oversized: !!cols.is_oversized, is_fragile: !!cols.is_fragile, shipping_notes: cols.shipping_notes || null };
}

// The item columns a store default produces for a NEW item (only when the default is on).
function columnsFromStoreDefaults(defs) {
  if (!defs || defs.enabled !== true) return null;
  return normalizeShippingInput({ ...defs, shippable: true }, {}) && {
    shippable: true, shipping_method: defs.shipping_method, shipping_price_mode: defs.shipping_price_mode,
    shipping_cost_cents: defs.shipping_price_mode === 'free' ? null : defs.shipping_cost_cents, shipping_destinations: defs.shipping_destinations,
    shipping_states: defs.shipping_states || [], handling_days: defs.handling_days == null ? null : defs.handling_days,
    is_oversized: !!defs.is_oversized, is_fragile: !!defs.is_fragile, shipping_notes: defs.shipping_notes || null };
}

function money(c) { return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/** Public, buyer-facing summary (item page, widget, feeds). No private data. */
function publicShipping(item) {
  const o = shippingOffer(item);
  const pickup = 'Local pickup available';
  if (!o.available) {
    return { pickup: true, shipping: null, pickup_only: o.reason === 'PICKUP_ONLY',
      summary: o.reason === 'PICKUP_ONLY' ? 'Pickup only — this item is not shipped' : 'Local pickup available · shipping not offered yet',
      oversized: o.oversized, fragile: o.fragile };
  }
  const where = o.destinations === 'listed_states' ? `ships to ${o.states.join(', ')}` : `ships to ${DESTINATIONS[o.destinations]}`;
  const price = o.shipping_cents === 0 ? 'Free shipping' : `Shipping ${money(o.shipping_cents)}`;
  const handling = o.handling_days != null ? ` · ships within ${o.handling_days} business day${o.handling_days === 1 ? '' : 's'}` : '';
  return { pickup: true, pickup_only: false,
    shipping: { method: o.method, method_label: o.method_label, price_mode: o.price_mode, shipping_cents: o.shipping_cents,
      destinations: o.destinations, states: o.states, handling_days: o.handling_days },
    summary: `${price} (${o.method_label}) · ${where}${handling} · ${pickup}`, oversized: o.oversized, fragile: o.fragile, notes: o.notes };
}

/** Schema.org OfferShippingDetails for a shippable item (only when the charge and destinations are known). */
function shippingDetailsJsonLd(item) {
  const o = shippingOffer(item);
  if (!o.available) return undefined;
  const regions = o.destinations === 'listed_states' ? o.states : null;
  const dest = { '@type': 'DefinedRegion', addressCountry: 'US', ...(regions ? { addressRegion: regions } : {}) };
  const d = { '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: (o.shipping_cents / 100).toFixed(2), currency: 'USD' },
    shippingDestination: dest };
  if (o.handling_days != null) d.deliveryTime = { '@type': 'ShippingDeliveryTime', handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: o.handling_days, unitCode: 'DAY' } };
  return d;
}

// The shipping terms recorded permanently on an order (what was offered and what the buyer chose).
function snapshotTerms(item, method, shippingCents) {
  const o = shippingOffer(item);
  return { selected: method, shipping_cents: method === 'shipping' ? shippingCents : 0,
    offered: o.available ? { method: o.method, price_mode: o.price_mode, shipping_cents: o.shipping_cents, destinations: o.destinations,
      states: o.states, handling_days: o.handling_days } : null,
    oversized: o.oversized, fragile: o.fragile, notes: o.notes };
}

module.exports = { METHODS, DESTINATIONS, PRICE_MODES, US_STATES, NON_CONTIGUOUS, shippingOffer, destinationAllowed, shippingChargeFor,
  normalizeShippingInput, normalizeStoreDefaults, columnsFromStoreDefaults, publicShipping, shippingDetailsJsonLd, snapshotTerms };
