'use strict';

/**
 * productData.js — the ONE place that turns a storefront item into public product data: the canonical URL, the
 * Schema.org Product/Offer, and (later) every shopping-feed mapper (permanent roadmap §4; migration 200).
 *
 * Rules:
 *   • Product identifiers (brand, GTIN, MPN) are published only when the seller entered them. Nothing is guessed or
 *     generated; a GTIN with a wrong check digit is refused, never "corrected".
 *   • identifierExists() is DERIVED: true only with a GTIN, or a brand plus a manufacturer part number. Antiques,
 *     vintage, handmade and one-of-a-kind items therefore publish as having no identifiers.
 *   • Price is the item price only: storefront Buy Now never carries a buyer's premium, and the seller's fee is never
 *     part of a public price.
 *   • Availability follows the item's real status: active → in stock; held in a checkout → out of stock; sold → sold out.
 *   • Only allow-listed, public fields are used (marketplaceItemService.publicItem): city/state only, no seller ids,
 *     addresses, buyer or order data.
 * Pure (no DB).
 */

const CONDITION_TYPES = ['new', 'used', 'refurbished'];
const SCHEMA_CONDITION = { new: 'https://schema.org/NewCondition', used: 'https://schema.org/UsedCondition', refurbished: 'https://schema.org/RefurbishedCondition' };
const SCHEMA_AVAILABILITY = { active: 'https://schema.org/InStock', pending_purchase: 'https://schema.org/OutOfStock', sold: 'https://schema.org/SoldOut' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(code, message) { const e = new Error(message); e.status = 422; e.code = code; return e; }

// GS1 check digit (GTIN-8/12/13/14).
function validGtin(v) {
  const s = String(v || '');
  if (!/^([0-9]{8}|[0-9]{12,14})$/.test(s)) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = (w === 3 ? 1 : 3)) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

const text = (v, max) => {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Validate the seller's optional product details. Returns only the keys present in `input` (so a PATCH changes only
 * what was sent); an empty string clears a field. Throws 422 on an invalid GTIN or condition type.
 */
function normalizeProductFields(input = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  if (has('brand')) out.brand = text(input.brand, 120);
  if (has('manufacturer')) out.manufacturer = text(input.manufacturer, 120);
  if (has('mpn')) out.mpn = text(input.mpn, 70);
  if (has('era_or_period')) out.era_or_period = text(input.era_or_period, 120);
  if (has('material')) out.material = text(input.material, 200);
  if (has('gtin')) {
    const g = input.gtin == null ? '' : String(input.gtin).replace(/[\s-]/g, '');
    if (!g) out.gtin = null;
    else if (!validGtin(g)) throw err('GTIN_INVALID', 'That barcode number (UPC/EAN/GTIN) is not valid. Check it, or leave it blank if the item has none.');
    else out.gtin = g;
  }
  if (has('condition_type')) {
    const c = input.condition_type == null || input.condition_type === '' ? null : String(input.condition_type).toLowerCase();
    if (c !== null && !CONDITION_TYPES.includes(c)) throw err('CONDITION_TYPE_INVALID', 'Choose new, used or refurbished.');
    out.condition_type = c;
  }
  if (has('image_alt')) {
    if (!Array.isArray(input.image_alt)) throw err('IMAGE_ALT_INVALID', 'Photo descriptions must be a list.');
    out.image_alt = input.image_alt.slice(0, 24).map((a) => text(a, 200) || '');
  }
  return out;
}

function identifierExists(item) { return !!(item && (item.gtin || (item.brand && item.mpn))); }

function slugify(title) {
  const s = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  return s || 'item';
}

function canonicalPath(item) { return `/shop/item/${item.id}/${slugify(item.title)}`; }
function canonicalUrl(base, item) { return String(base).replace(/\/+$/, '') + canonicalPath(item); }

function imagesOf(item) {
  const imgs = Array.isArray(item.images) && item.images.length ? item.images : (item.thumbnail_url ? [item.thumbnail_url] : []);
  return imgs.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
}

// A meaningful description for each photo: the seller's own text, else the title with the view number.
function altTexts(item) {
  const given = Array.isArray(item.image_alt) ? item.image_alt : [];
  return imagesOf(item).map((_, i) => (given[i] && String(given[i]).trim()) || (i === 0 ? String(item.title || 'Item') : `${item.title || 'Item'} - photo ${i + 1}`));
}

function priceString(cents) { return (Math.max(0, parseInt(cents, 10) || 0) / 100).toFixed(2); }

function metaDescription(item) {
  const bits = [];
  const d = text(item.description, 400);
  if (d) bits.push(d);
  else {
    const place = [item.city, item.state].filter(Boolean).join(', ');
    bits.push(`${item.title} for $${priceString(item.price_cents)}${item.seller_name ? ' from ' + item.seller_name : ''}${place ? ' in ' + place : ''}.`);
  }
  const s = bits.join(' ');
  return s.length > 160 ? s.slice(0, 157).replace(/\s+\S*$/, '') + '…' : s;
}

/**
 * Schema.org Product + Offer for one PUBLIC item (the allow-listed shape from marketplaceItemService.publicItem).
 * `seller` is the item's own seller organisation when its branding is public; otherwise Advantage.Bid.
 */
function productJsonLd(item, base) {
  const url = canonicalUrl(base, item);
  const images = imagesOf(item);
  const p = { '@context': 'https://schema.org', '@type': 'Product', '@id': url + '#product', name: item.title, url, sku: item.id };
  if (images.length) p.image = images;
  const d = text(item.description, 5000);
  if (d) p.description = d;
  if (item.category) p.category = text(item.category, 200);
  if (item.brand) p.brand = { '@type': 'Brand', name: item.brand };
  if (item.manufacturer) p.manufacturer = { '@type': 'Organization', name: item.manufacturer };
  if (item.gtin) p.gtin = item.gtin;
  if (item.mpn) p.mpn = item.mpn;
  if (item.material) p.material = item.material;
  if (item.condition_type && SCHEMA_CONDITION[item.condition_type]) p.itemCondition = SCHEMA_CONDITION[item.condition_type];
  const props = [];
  if (item.era_or_period) props.push({ '@type': 'PropertyValue', name: 'Era or period', value: item.era_or_period });
  if (item.condition) props.push({ '@type': 'PropertyValue', name: 'Condition details', value: text(item.condition, 200) });
  if (props.length) p.additionalProperty = props;
  const offer = { '@type': 'Offer', url, price: priceString(item.price_cents), priceCurrency: 'USD',
    availability: SCHEMA_AVAILABILITY[item.status] || 'https://schema.org/OutOfStock' };
  if (p.itemCondition) offer.itemCondition = p.itemCondition;
  offer.seller = item.seller_name ? { '@type': 'Organization', name: item.seller_name, ...(item.storefront_slug ? { url: String(base).replace(/\/+$/, '') + '/pro/' + item.storefront_slug } : {}) }
    : { '@type': 'Organization', name: 'Advantage.Bid' };
  p.offers = offer;
  return p;
}

function breadcrumbJsonLd(item, base) {
  const b = String(base).replace(/\/+$/, '');
  const list = [{ '@type': 'ListItem', position: 1, name: 'Advantage.Bid', item: b + '/' }];
  if (item.seller_name && item.storefront_slug) list.push({ '@type': 'ListItem', position: 2, name: item.seller_name, item: b + '/pro/' + item.storefront_slug });
  list.push({ '@type': 'ListItem', position: list.length + 1, name: item.title, item: canonicalUrl(b, item) });
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: list };
}

module.exports = { CONDITION_TYPES, SCHEMA_CONDITION, SCHEMA_AVAILABILITY, UUID_RE, validGtin, normalizeProductFields, identifierExists,
  slugify, canonicalPath, canonicalUrl, imagesOf, altTexts, priceString, metaDescription, productJsonLd, breadcrumbJsonLd };
