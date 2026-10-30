'use strict';

/**
 * storefrontImportService — the simple marketplace inventory importer for Professional Sellers (CSV / Excel .xlsx).
 * Migrations 207 + 209. The seller never renames columns.
 *
 * Standard workflow (public/seller-inventory.html): 1. Upload Spreadsheet → 2. Match Columns → 3. Add or Match Photos →
 * 4. Review Inventory → 5. Import Drafts. There is no category step: categories are assigned automatically.
 *
 * Column matching: every spreadsheet heading gets ONE destination: one of the ten primary fields, Photo_1..Photo_15, or
 * Skip / Ignore. Skip / Ignore is the only destination that may be chosen for more than one column (enforced here and in
 * the page). Common headings are suggested automatically (INV#, Inventory Num, Item Number, SKU, Lead, Short Description,
 * Qty, Price, …), and the seller's approved choices are saved per seller and source software (header fingerprint), so the
 * next export from the same software maps itself.
 *
 * Pricing: Sale Price is the ONLY marketplace price. Reserve prices, estimates, starting bids, bid amounts and other
 * historical auction prices are never a destination and are never converted (a column that holds them cannot be mapped
 * to Sale Price). A row without a Sale Price is imported as a draft for the seller to price later.
 *
 * Categories: assigned automatically during the preview/import (storefrontCategoryService: the spreadsheet's category
 * when it maps to the taxonomy, otherwise the item's own words; pending rather than guessed). Never a blocking step.
 *
 * Safety (unchanged from 207): the company is always the one resolved from the session; a batch is only ever read or
 * imported by that company; the server imports exactly the validated preview it stored; retries never create the same
 * item twice (unique batch row); duplicates against the seller's own inventory are skipped, or (if the seller chooses)
 * update the matching DRAFT only, never a published, paused or sold item. No photo is ever invented.
 */

const crypto = require('crypto');
const db = require('../db');
const items = require('./marketplaceItemService');
const sheet = require('../lib/spreadsheet');
const categories = require('./storefrontCategoryService');
const { isProfessional } = require('./sellerTypeRules');
const { withTransaction } = require('../utils/withTransaction');

function err(status, code, message, extra) { const e = new Error(message); e.status = status; e.code = code; if (extra) Object.assign(e, extra); return e; }

const CHUNK = 100;          // rows imported per call (the page calls again until done, showing progress)
const MAX_TITLE = 200, MAX_DESCRIPTION = 10000, MAX_CONDITION = 1000, MAX_DIMENSIONS = 200, MAX_MATERIAL = 200, MAX_COLOR = 80, MAX_CATEGORY = 100;
const MAX_PRICE_CENTS = 100000000;   // $1,000,000 per item
const MAX_PHOTO_REFS = 15;
const EXAMPLE_PREFIX = 'EXAMPLE-';
const MAPPING_VERSION = 2;

// ── Destinations ─────────────────────────────────────────────────────────────────────────────────────────────────
// The ten primary fields (in the order the page lists them), then Photo_1..Photo_15, then Skip / Ignore.
const PRIMARY = [
  { key: 'inventory_number', label: 'Inventory Number' },
  { key: 'title', label: 'Item Title', required: true },
  { key: 'description', label: 'Description' },
  { key: 'price', label: 'Sale Price' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'category', label: 'Category' },
  { key: 'condition', label: 'Condition' },
  { key: 'dimensions', label: 'Dimensions' },
  { key: 'material', label: 'Material' },
  { key: 'color', label: 'Color' },
];
const PHOTO_KEYS = Array.from({ length: MAX_PHOTO_REFS }, (_, i) => `photo_${i + 1}`);
const SKIP = 'skip';
const DESTINATIONS = [...PRIMARY, ...PHOTO_KEYS.map((k, i) => ({ key: k, label: `Photo_${i + 1}`, photo: true })), { key: SKIP, label: 'Skip / Ignore', repeatable: true }];
const DEST_KEYS = new Set(DESTINATIONS.map((d) => d.key));

// Headings are compared normalized: lower case, separators (_ - . /) as spaces, letters/digits/# kept.
const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[_\-./\\]+/g, ' ').replace(/[^a-z0-9# ]+/g, ' ').replace(/\s+/g, ' ').trim();
const squash = (h) => norm(h).replace(/[\s#]+/g, '');

// Suggested headings per destination, best first. Matching is exact on the normalized heading, or on the heading with
// spaces removed ("inventorynum", "itemnum", "shortdesc").
const SYNONYMS = {
  inventory_number: ['inventory number', 'inventory num', 'inventory #', 'inventory no', 'inv #', 'inv#', 'inv no', 'inv num', 'invnum', 'inv',
    'inventory', 'inventory id', 'item number', 'item num', 'itemnum', 'item #', 'item no', 'item id', 'sku', 'stock number', 'stock #', 'stock no',
    'tag number', 'tag #', 'product id', 'item code', 'product code', 'reference', 'ref #', 'ref no'],
  title: ['item title', 'title', 'lead', 'lead line', 'headline', 'name', 'item name', 'product name', 'product title', 'short title', 'heading', 'item'],
  description: ['description', 'item description', 'long description', 'longdesc', 'long desc', 'full description', 'details', 'item details',
    'catalog description', 'shortdesc', 'short description', 'short desc', 'desc', 'body', 'body html', 'body (html)'],
  price: ['sale price', 'price', 'asking price', 'selling price', 'retail price', 'list price', 'our price', 'buy now price', 'buy it now price',
    'fixed price', 'tag price', 'price usd', 'variant price', 'marketplace price', 'store price'],
  quantity: ['quantity', 'qty', 'quan', 'count', 'on hand', 'qty on hand', 'units', 'stock', 'qty available', 'quantity available', 'inventory qty', 'variant inventory qty'],
  category: ['category', 'categories', 'item category', 'product category', 'department', 'product type', 'category name', 'collection'],
  condition: ['condition', 'item condition', 'condition notes', 'condition report', 'condition description', 'cond', 'grade'],
  dimensions: ['dimensions', 'dimension', 'size', 'measurements', 'dims', 'overall dimensions', 'item dimensions', 'h x w x d'],
  material: ['material', 'materials', 'medium', 'composition', 'made of', 'metal', 'primary material'],
  color: ['color', 'colour', 'colors', 'colours', 'item color', 'primary color'],
};
// The original auction lot number: an internal import reference for photo matching, never a marketplace field.
const LOT_HEADINGS = ['lot number', 'lot num', 'lotnum', 'lot #', 'lot no', 'lot', 'original lot', 'original lot number', 'auction lot', 'lot id'];
// Auction prices that must never become a Sale Price (owner rule 2026-10-30).
const AUCTION_PRICE = /\b(reserve|bid|bids|bidamount|bidreserve|estimate|est|start|starting|opening|hammer|realized|realised|sold|previous|prior|high|low|minimum|min|cost|consignor|commission|premium)\b|bidamount|bidreserve|lowest|highest/;

function photoNumber(h) {
  const n = norm(h).replace(/\s+/g, ' ');
  const m = n.match(/^(photo|image|picture|img|pic|photo url|image url|picture url)\s*#?\s*(\d{1,2})$/) || n.match(/^(photo|image|picture|img|pic)(\d{1,2})( url)?$/);
  if (m) { const k = Number(m[2]); return k >= 1 && k <= MAX_PHOTO_REFS ? k : null; }
  if (/^(photo|photos|image|images|picture|pictures|photo url|image url|image src|main image|primary image|photo file|image file|photo filename|image filename)$/.test(n)) return 0;   // 0 = next free photo slot
  return null;
}
const isLotHeading = (h) => LOT_HEADINGS.includes(norm(h)) || LOT_HEADINGS.map((x) => x.replace(/[\s#]+/g, '')).includes(squash(h));
const looksLikeAuctionPrice = (h) => AUCTION_PRICE.test(norm(h)) || /bid|reserve|estimate/.test(squash(h));

/** Suggested destination for every column (array, in column order). Every non-skip destination is used once. */
function suggestColumns(headers) {
  const n = headers.length;
  const out = new Array(n).fill(SKIP);
  const used = new Set();
  const take = (dest, i) => { out[i] = dest; used.add(dest); };
  // Photos first (their headings are unambiguous).
  const generic = [];
  headers.forEach((h, i) => { const k = photoNumber(h); if (k === null) return; if (k === 0) generic.push(i); else if (!used.has(`photo_${k}`)) take(`photo_${k}`, i); });
  for (const i of generic) { const free = PHOTO_KEYS.find((k) => !used.has(k)); if (free) take(free, i); }
  // Primary fields, in priority order of their synonyms.
  for (const f of PRIMARY) {
    const names = SYNONYMS[f.key] || [];
    let idx = -1;
    for (const name of names) {
      idx = headers.findIndex((h, i) => out[i] === SKIP && h && !isLotHeading(h) && (norm(h) === name || squash(h) === name.replace(/[\s#]+/g, '')));
      if (idx !== -1) break;
    }
    if (idx === -1) continue;
    if (f.key === 'price' && looksLikeAuctionPrice(headers[idx])) continue;
    take(f.key, idx);
  }
  // A lone "short description" with no title column is the title (auction software uses it both ways).
  if (!used.has('title')) {
    const i = headers.findIndex((h, j) => out[j] === 'description' && /^(short ?desc|short description)$/.test(norm(h)));
    if (i !== -1) { out[i] = 'title'; used.delete('description'); used.add('title'); }
  }
  return out;
}

/** The column holding the original auction lot number, or -1. */
function lotColumn(headers) { return headers.findIndex((h) => isLotHeading(h)); }

/**
 * Check a client-supplied column mapping (array of destination keys, one per column). Skip / Ignore may repeat; every
 * other destination at most once; Item Title is required; an auction-price column can never be the Sale Price.
 */
function checkColumns(columns, headers) {
  if (columns == null) return null;
  if (!Array.isArray(columns) || columns.length !== headers.length) throw err(422, 'MAPPING_INVALID', 'The column choices do not match the spreadsheet. Upload it again.');
  const seen = new Map();
  const out = columns.map((c, i) => {
    const k = c == null || c === '' ? SKIP : String(c);
    if (!DEST_KEYS.has(k)) throw err(422, 'MAPPING_INVALID', `"${String(c).slice(0, 40)}" is not one of the choices.`);
    if (k !== SKIP) {
      if (seen.has(k)) {
        const label = DESTINATIONS.find((d) => d.key === k).label;
        throw err(422, 'MAPPING_DUPLICATE', `${label} is chosen for two columns ("${headers[seen.get(k)] || 'column ' + (seen.get(k) + 1)}" and "${headers[i] || 'column ' + (i + 1)}"). Choose it for one column, and Skip / Ignore for the other.`, { destination: k, columns: [seen.get(k), i] });
      }
      seen.set(k, i);
    }
    if (k === 'price' && looksLikeAuctionPrice(headers[i])) {
      throw err(422, 'MAPPING_AUCTION_PRICE', `"${headers[i]}" holds auction prices (such as a reserve, estimate or bid), which are never used as a Sale Price. Choose Skip / Ignore for it; you can set Sale Prices after importing.`, { columns: [i] });
    }
    return k;
  });
  return out;
}
const destIndex = (columns, key) => columns.indexOf(key);

// The source software, for the seller's saved mappings and the page's wording.
function sourceLabel(headers) {
  const h = new Set(headers.map(squash));
  if (['lotnum', 'lead', 'itemnum'].every((x) => h.has(x)) || (h.has('lead') && h.has('bidreserve'))) return 'AuctionFlex export';
  if (h.has('handle') && h.has('variantprice')) return 'Shopify export';
  if (h.has('listingid') && h.has('tags') && h.has('quantity')) return 'Etsy export';
  return 'Spreadsheet';
}
const signatureOf = (headers) => crypto.createHash('sha256').update(headers.map(norm).join('|')).digest('hex');

// ── Value parsing ────────────────────────────────────────────────────────────────────────────────────────────────
const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim();

/** "$1,234.50" → 123450 cents. Returns { cents } or { error, suggestion }. */
function parsePrice(raw) {
  const s0 = clean(raw);
  if (!s0) return {};
  let s = s0.replace(/^(usd|us\$)\s*/i, '').replace(/\s*(usd)$/i, '').replace(/^\$\s*/, '').replace(/\s+/g, '');
  if (/^-/.test(s) || /^\(.*\)$/.test(s)) return { error: `Sale Price "${s0}" is negative.`, suggestion: 'Enter a price above zero, or leave it blank and set it later.' };
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) return { error: `Sale Price "${s0}" uses a comma for cents.`, suggestion: `Write it with a decimal point, for example ${s.replace(/\./g, '').replace(',', '.')}.` };
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: `Sale Price "${s0.slice(0, 40)}" is not a price.`, suggestion: 'Use numbers only, for example 125 or 1250.00, or leave it blank and set it later.' };
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 2) {
    // Excel often stores 19.99 as 19.990000000000002: accept a value that is cents within rounding error.
    const n = Number(s); const c = Math.round(n * 100);
    if (Math.abs(n * 100 - c) > 1e-6) return { error: `Sale Price "${s0}" has more than two decimal places.`, suggestion: 'Round the price to whole cents.' };
    return range(c, s0);
  }
  return range(parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10), s0);
}
function range(cents, s0) {
  if (!(cents > 0)) return { error: 'The Sale Price is zero.', suggestion: 'Enter a price above zero, or leave it blank and set it later. Items are never listed for free.' };
  if (cents > MAX_PRICE_CENTS) return { error: `Sale Price "${s0}" is above the $1,000,000 limit per item.`, suggestion: 'Check for a typing mistake, or contact Advantage.Bid for very high-value items.' };
  return { cents };
}

function parseQuantity(raw) {
  const s = clean(raw);
  if (!s) return { value: 1 };
  if (!/^\d+(\.0+)?$/.test(s)) return { error: `Quantity "${s.slice(0, 20)}" is not a whole number.`, suggestion: 'Use a whole number such as 1, or leave it blank for 1.' };
  const n = parseInt(s, 10);
  if (n > 100000) return { error: `Quantity ${n} is above the limit of 100,000.`, suggestion: 'Check for a typing mistake.' };
  return { value: n };
}

// Photo references in one cell: an image file name, or a permitted image link (http/https). Several may share a cell,
// separated by commas, semicolons, pipes or line breaks.
function photoRefs(cell) {
  const s = clean(cell);
  if (!s) return [];
  return s.split(/[|;,\n\r]+|\s+(?=https?:\/\/)/i).map((x) => x.trim()).filter(Boolean).map((x) => {
    if (/^https?:\/\//i.test(x)) {
      let u; try { u = new URL(x); } catch (_) { return { type: 'invalid', value: x.slice(0, 200), reason: 'This photo link is not a valid web address.' }; }
      if (x.length > 2000) return { type: 'invalid', value: x.slice(0, 200), reason: 'This photo link is too long.' };
      return { type: 'url', value: u.toString() };
    }
    const base = x.split(/[\\/]/).pop();
    if (!base || base.length > 255) return { type: 'invalid', value: x.slice(0, 200), reason: 'This photo file name is not usable.' };
    if (!/\.(jpe?g|png|gif|webp|heic|heif)$/i.test(base)) return { type: 'invalid', value: base, reason: 'Photos must be JPEG, PNG, GIF, WebP or HEIC files.' };
    return { type: 'file', value: base };
  });
}

// ── Validate one row ─────────────────────────────────────────────────────────────────────────────────────────────
function validateRow(cells, columns, ctx) {
  const at = (k) => destIndex(columns, k);
  const get = (k) => { const i = at(k); return i === -1 ? undefined : clean(cells[i]); };
  const errors = []; const warnings = []; const v = {};
  const bad = (field, message, suggestion) => errors.push({ field, message, suggestion: suggestion || null });

  // Inventory Number
  const invRaw = get('inventory_number');
  if (invRaw) {
    try { v.inventory_number = items._normalizeInventoryNumber(invRaw); }
    catch (e) { bad('inventory_number', e.message, 'Shorten the inventory number to 64 characters or fewer.'); }
  }
  if (v.inventory_number && v.inventory_number.toUpperCase().startsWith(EXAMPLE_PREFIX)) bad('inventory_number', 'This is one of the template\'s example rows.', 'Delete the example rows before importing.');

  // Item Title
  const title = get('title');
  if (!title) bad('title', 'Item Title is missing.', 'Every item needs a short title, for example "Victorian walnut side table".');
  else if (title.length > MAX_TITLE) bad('title', `Item Title is ${title.length} characters (limit ${MAX_TITLE}).`, 'Shorten the title and move extra detail to the description.');
  else v.title = title;

  // Sale Price (optional: a draft can be priced later) and Quantity
  const p = parsePrice(get('price'));
  if (p.error) bad('price', p.error, p.suggestion);
  else if (p.cents) v.price_cents = p.cents;
  else warnings.push({ field: 'price', code: 'MISSING_PRICE', message: 'No Sale Price. The item is imported as a draft; set its price before publishing.', suggestion: null });
  const q = parseQuantity(get('quantity'));
  if (q.error) bad('quantity', q.error, q.suggestion); else v.quantity = q.value;
  if (v.quantity === 0) warnings.push({ field: 'quantity', code: 'QUANTITY_ZERO', message: 'Quantity is 0, so the item is imported as a draft with nothing available.', suggestion: null });

  // Text details
  const limit = (k, max, label, hint) => { const x = get(k); if (!x) return; if (x.length > max) bad(k, `${label} is longer than ${max} characters.`, hint); else v[k] = x; };
  limit('description', MAX_DESCRIPTION, 'Description', 'Shorten the description.');
  limit('condition', MAX_CONDITION, 'Condition', 'Shorten the condition notes.');
  limit('dimensions', MAX_DIMENSIONS, 'Dimensions', 'Shorten the dimensions, for example 30 x 24 x 18 in.');
  limit('material', MAX_MATERIAL, 'Material', 'Shorten the material.');
  limit('color', MAX_COLOR, 'Color', 'Shorten the color.');
  const catText = get('category');
  if (catText && catText.length > MAX_CATEGORY) bad('category', `Category is longer than ${MAX_CATEGORY} characters.`, 'Use a short category name, or Skip / Ignore the column.');

  // Automatic category (never a blocking step): the spreadsheet's category if it maps, otherwise the item's own words.
  v.category = categories.classify({ category: catText && catText.length <= MAX_CATEGORY ? catText : null, title: v.title, description: v.description, material: v.material });

  // Photo references (Photo_1..Photo_15), in order.
  const refs = [];
  PHOTO_KEYS.forEach((k) => { const i = at(k); if (i === -1) return; for (const r of photoRefs(cells[i])) refs.push(r); });
  for (const r of refs.filter((x) => x.type === 'invalid')) warnings.push({ field: 'photos', code: 'PHOTO_REF_INVALID', message: `Photo "${r.value}": ${r.reason}`, suggestion: null });
  v.photo_refs = refs.filter((x) => x.type !== 'invalid').slice(0, MAX_PHOTO_REFS * 2);

  // Photo matching reference and the original lot number (internal references, never public fields).
  if (ctx.matchColumn !== -1) { const m = clean(cells[ctx.matchColumn]); if (m && m.length <= 64) v.match_ref = m; }
  else if (ctx.photoMatch.reference === 'inventory_number' && v.inventory_number) v.match_ref = v.inventory_number;
  if (ctx.lotColumn !== -1) { const l = clean(cells[ctx.lotColumn]); if (l && l.length <= 64) v.source_lot_number = l; }

  // Duplicates: within this file, then against the seller's own inventory (never another seller's).
  let action = errors.length ? 'error' : 'create';
  if (v.inventory_number) {
    const key = v.inventory_number.toLowerCase();
    const first = ctx.seen.get(key);
    if (first) { bad('inventory_number', `Inventory Number "${v.inventory_number}" is also on row ${first} of this file.`, 'Give each item its own inventory number, or delete the repeated row.'); action = 'error'; }
    else ctx.seen.set(key, ctx.rowNumber);
    const existing = ctx.existing.get(key);
    if (action === 'create' && existing) {
      if (ctx.duplicateMode === 'update_drafts' && existing.status === 'draft') {
        action = 'update'; v.target_item_id = existing.id;
        warnings.push({ field: 'inventory_number', code: 'UPDATES_DRAFT', message: `Updates your existing draft "${existing.title}".`, suggestion: null });
      } else {
        action = 'skip';
        warnings.push({ field: 'inventory_number', code: 'ALREADY_IN_INVENTORY', message: `Already in your inventory as "${existing.title}" (${existing.label}). It will be skipped; nothing about it changes.`, suggestion: null });
      }
    }
  } else {
    warnings.push({ field: 'inventory_number', code: 'NO_INVENTORY_NUMBER', message: 'No Inventory Number. Repeat imports cannot recognise this item.', suggestion: 'Add an inventory number to every row if your software has one.' });
  }
  return { row: ctx.rowNumber, values: v, errors, warnings, action };
}

// ── Seller context ───────────────────────────────────────────────────────────────────────────────────────────────
async function sellerOf(actor) {
  const seller = await items.sellerForUser(actor);
  if (!seller) throw err(403, 'NOT_A_SELLER', 'No seller profile.');
  if (!isProfessional(seller.seller_type)) throw err(403, 'NOT_PROFESSIONAL', 'Bulk import is for Professional Sellers.');
  return seller;
}
const actorUserId = (actor) => (actor && typeof actor === 'object' ? actor.userId : actor) || null;
const STATUS_LABEL = { draft: 'draft', active: 'published', paused: 'paused', pending_purchase: 'in checkout' };

async function existingItems(sellerId) {
  const { rows } = await db.query(
    `SELECT id, lower(inventory_number) AS k, title, status FROM marketplace_items
      WHERE seller_id = $1 AND inventory_number IS NOT NULL AND status IN ('draft','active','paused','pending_purchase')`, [sellerId]);
  return new Map(rows.map((r) => [r.k, { id: r.id, title: r.title, status: r.status, label: STATUS_LABEL[r.status] || r.status }]));
}

function normalizePhotoMatch(pm, columns, headers) {
  const o = pm && typeof pm === 'object' ? pm : {};
  const ref = ['inventory_number', 'lot_number', 'column', 'none'].includes(o.reference) ? o.reference : null;
  const lot = lotColumn(headers);
  if (ref === 'column' || ref === 'lot_number') {
    const c = ref === 'lot_number' && (o.column == null || o.column === '') ? lot : Number(o.column);
    if (!Number.isInteger(c) || c < 0 || c >= headers.length) throw err(422, 'PHOTO_MATCH_INVALID', ref === 'lot_number' ? 'Choose the column that holds the original auction lot number.' : 'Choose the column to match photos by.');
    return { reference: ref, column: c };
  }
  if (ref === 'inventory_number' || ref === 'none') return { reference: ref, column: null };
  // Default: the inventory number when it is mapped, otherwise the lot number column when there is one.
  if (destIndex(columns, 'inventory_number') !== -1) return { reference: 'inventory_number', column: null };
  if (lot !== -1) return { reference: 'lot_number', column: lot };
  return { reference: 'none', column: null };
}

// ── Preview ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Parse + validate an uploaded spreadsheet; store the validated preview; create nothing. */
async function preview(actor, { buffer, filename, columns, photoMatch, duplicateMode }) {
  const seller = await sellerOf(actor);
  const fileName = clean(String(filename || 'inventory.csv').split(/[\\/]/).pop()).slice(0, 200) || 'inventory.csv';
  const recent = (await db.query(
    `SELECT count(*)::int AS n FROM storefront_import_batches WHERE seller_id = $1 AND created_at > now() - interval '1 hour'`, [seller.id])).rows[0].n;
  if (recent >= 60) throw err(429, 'TOO_MANY_PREVIEWS', 'Too many previews in the last hour. Please wait a few minutes and try again.');

  const { kind, rows } = sheet.parse(buffer, fileName);
  const headers = (rows[0] || []).map((h) => clean(h).slice(0, 100));
  if (!headers.some(Boolean)) throw err(422, 'SHEET_NO_HEADER', 'The first row must name the columns (for example Inventory Number, Title, Price).');
  const signature = signatureOf(headers);
  const saved = (await db.query('SELECT id, columns, photo_match, source_label FROM storefront_import_mappings WHERE seller_id = $1 AND signature = $2', [seller.id, signature])).rows[0] || null;
  let mappingSource = 'suggested';
  let cols = checkColumns(columns, headers);
  if (cols) mappingSource = 'seller';
  else if (saved && Array.isArray(saved.columns) && saved.columns.length === headers.length) {
    try { cols = checkColumns(saved.columns, headers); mappingSource = 'saved'; } catch (_) { cols = null; }
  }
  if (!cols) cols = suggestColumns(headers);
  const pm = normalizePhotoMatch(photoMatch || (mappingSource === 'saved' ? saved.photo_match : null), cols, headers);
  const mode = duplicateMode === 'update_drafts' ? 'update_drafts' : 'skip';
  const missing = PRIMARY.filter((f) => f.required && destIndex(cols, f.key) === -1).map((f) => f.label);

  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const ctx = {
    rowNumber: 0, seen: new Map(), existing: await existingItems(seller.id), duplicateMode: mode, photoMatch: pm,
    matchColumn: pm.reference === 'column' || pm.reference === 'lot_number' ? pm.column : -1,
    lotColumn: pm.reference === 'lot_number' ? pm.column : lotColumn(headers),
  };
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] || [];
    if (cells.every((c) => !clean(c))) continue;                 // blank rows between items are ignored
    ctx.rowNumber = i + 1;                                       // the spreadsheet's own row number (header = row 1)
    out.push(missing.length ? { row: i + 1, values: {}, errors: [], warnings: [], action: 'error' } : validateRow(cells, cols, ctx));
  }
  if (!out.length) throw err(422, 'SHEET_EMPTY', 'The spreadsheet has a header row but no items.');

  const previous = (await db.query(
    `SELECT id, created_at, created_count FROM storefront_import_batches
      WHERE seller_id = $1 AND file_sha256 = $2 AND created_count > 0 ORDER BY created_at DESC LIMIT 1`, [seller.id, sha])).rows[0] || null;
  // A new preview of the same file replaces this seller's earlier, never-imported previews of it (and their staged photos).
  const stale = (await db.query(`SELECT b.id FROM storefront_import_batches b WHERE b.seller_id = $1 AND b.file_sha256 = $2 AND b.status = 'previewed'
                    AND NOT EXISTS (SELECT 1 FROM marketplace_items mi WHERE mi.import_batch_id = b.id)`, [seller.id, sha])).rows.map((r) => r.id);
  if (stale.length) {
    // Re-checked under a row lock: a batch whose import started meanwhile (another tab) is never deleted.
    const storedCopies = await withTransaction(async (client) => {
      const ids = (await client.query(
        `SELECT b.id FROM storefront_import_batches b WHERE b.id = ANY($1::uuid[]) AND b.seller_id = $2 AND b.status = 'previewed'
           AND NOT EXISTS (SELECT 1 FROM marketplace_items mi WHERE mi.import_batch_id = b.id) FOR UPDATE`, [stale, seller.id])).rows.map((r) => r.id);
      if (!ids.length) return [];
      const copies = (await client.query("SELECT public_id FROM storefront_import_photos WHERE batch_id = ANY($1::uuid[]) AND status = 'staged'", [ids])).rows.map((r) => r.public_id);
      await client.query('DELETE FROM storefront_import_batches WHERE id = ANY($1::uuid[])', [ids]);   // staged photo rows cascade
      return copies;
    });
    // The stored copies of those staged photos are removed afterwards (best effort; never part of the transaction).
    for (const pid of storedCopies) if (pid) require('./cloudinaryService').destroy(pid).catch(() => {});
  }
  const ready = out.filter((r) => r.action === 'create' || r.action === 'update').length;
  const mapping = { version: MAPPING_VERSION, columns: cols, headers, signature, source_label: sourceLabel(headers), mapping_source: mappingSource, lot_column: lotColumn(headers) };
  const batch = (await db.query(
    `INSERT INTO storefront_import_batches (seller_id, created_by, file_name, file_kind, file_sha256, mapping, rows, total_rows, ready_rows, photo_match, duplicate_mode, mapping_version)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11,$12) RETURNING id, created_at`,
    [seller.id, actorUserId(actor), fileName, kind, sha, JSON.stringify(mapping), JSON.stringify(out), out.length, missing.length ? 0 : ready,
     JSON.stringify(Object.assign({}, pm, { stats: {} })), mode, MAPPING_VERSION])).rows[0];
  return {
    batch_id: batch.id, file_name: fileName, file_kind: kind, headers, columns: cols, destinations: DESTINATIONS.map(({ key, label, required, photo, repeatable }) => ({ key, label, required: !!required, photo: !!photo, repeatable: !!repeatable })),
    mapping_source: mappingSource, source_label: mapping.source_label, lot_column: mapping.lot_column, photo_match: pm, duplicate_mode: mode,
    missing_required: missing,
    // Up to two example values per column, so the seller can recognise each heading.
    example_values: headers.map((_, c) => rows.slice(1).map((r) => clean((r || [])[c])).filter(Boolean).slice(0, 2).map((x) => x.slice(0, 60)).join(' · ')),
    summary: summarize(out),
    photo_references: photoReferenceSummary(out),
    previously_imported: previous ? { batch_id: previous.id, at: previous.created_at, created_count: previous.created_count } : null,
    rows: out.slice(0, 1000).map(rowView), row_count: out.length,
  };
}

// What the page needs per row (never the internal match reference spelled out as a field).
function rowView(r) {
  const v = r.values || {};
  return { row: r.row, action: r.action, errors: r.errors, warnings: r.warnings,
    values: { inventory_number: v.inventory_number || null, title: v.title || null, price_cents: v.price_cents || null, quantity: v.quantity != null ? v.quantity : null,
      category: v.category && v.category.label ? v.category.label : null, photo_refs: (v.photo_refs || []).length, match_ref: v.match_ref || null } };
}

function summarize(rows, photos) {
  const s = {
    total: rows.length,
    create: rows.filter((r) => r.action === 'create').length,
    update: rows.filter((r) => r.action === 'update').length,
    skip: rows.filter((r) => r.action === 'skip').length,
    errors: rows.filter((r) => r.action === 'error').length,
    missing_price: rows.filter((r) => (r.action === 'create' || r.action === 'update') && !(r.values && r.values.price_cents)).length,
    warnings: rows.filter((r) => r.warnings && r.warnings.length).length,
  };
  s.ready = s.create + s.update;
  s.new_items = s.create;
  s.existing_items = s.update + s.skip;
  if (photos) Object.assign(s, { photos_matched: photos.matched, photos_unmatched: photos.unmatched, photos_ambiguous: photos.ambiguous, photos_duplicate: photos.duplicate, photos_missing: photos.missing });
  return s;
}

// The photo files and links the spreadsheet names (for step 3: which files to add, which links will be fetched).
function photoReferenceSummary(rows) {
  let files = 0; let links = 0; const rowsWithRefs = new Set();
  for (const r of rows) {
    if (r.action !== 'create' && r.action !== 'update') continue;
    for (const p of (r.values && r.values.photo_refs) || []) { if (p.type === 'file') files++; else if (p.type === 'url') links++; rowsWithRefs.add(r.row); }
  }
  return { file_names: files, links, rows: rowsWithRefs.size };
}

// ── Batch access ─────────────────────────────────────────────────────────────────────────────────────────────────
async function loadOwnBatch(sellerId, batchId, runner = db, lock = false) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(batchId || ''))) throw err(404, 'NOT_FOUND', 'Import not found.');
  const b = (await runner.query(`SELECT * FROM storefront_import_batches WHERE id = $1 AND seller_id = $2${lock ? ' FOR UPDATE' : ''}`, [batchId, sellerId])).rows[0];
  if (!b) throw err(404, 'NOT_FOUND', 'Import not found.');
  return b;
}

/** Change the photo-matching reference or duplicate handling of a previewed batch (re-validates its stored rows). */
async function updateOptions(actor, batchId, { photoMatch, duplicateMode }) {
  const seller = await sellerOf(actor);
  const b = await loadOwnBatch(seller.id, batchId);
  if (b.status !== 'previewed') throw err(409, 'ALREADY_IMPORTED', 'This import has already started; its options can no longer change.');
  const headers = (b.mapping && b.mapping.headers) || [];
  const cols = (b.mapping && b.mapping.columns) || [];
  const pm = normalizePhotoMatch(photoMatch || b.photo_match, cols, headers);
  const mode = duplicateMode === 'update_drafts' ? 'update_drafts' : duplicateMode === 'skip' ? 'skip' : b.duplicate_mode;
  // Recompute what depends on the options, from the stored rows (the file itself is not kept).
  const existing = await existingItems(seller.id);
  const rows = (b.rows || []).map((r) => {
    if (r.action === 'error') return r;
    const v = Object.assign({}, r.values);
    const warnings = (r.warnings || []).filter((w) => !['ALREADY_IN_INVENTORY', 'UPDATES_DRAFT'].includes(w.code));
    let action = 'create'; delete v.target_item_id;
    const ex = v.inventory_number ? existing.get(v.inventory_number.toLowerCase()) : null;
    if (ex) {
      if (mode === 'update_drafts' && ex.status === 'draft') { action = 'update'; v.target_item_id = ex.id; warnings.push({ field: 'inventory_number', code: 'UPDATES_DRAFT', message: `Updates your existing draft "${ex.title}".`, suggestion: null }); }
      else { action = 'skip'; warnings.push({ field: 'inventory_number', code: 'ALREADY_IN_INVENTORY', message: `Already in your inventory as "${ex.title}" (${ex.label}). It will be skipped; nothing about it changes.`, suggestion: null }); }
    }
    if (pm.reference === 'inventory_number') v.match_ref = v.inventory_number || undefined;
    else if (pm.reference === 'none') delete v.match_ref;
    return Object.assign({}, r, { values: v, warnings, action });
  });
  // A column reference needs the original cells: keep the existing references unless the column changes.
  const prevCol = b.photo_match && b.photo_match.column;
  if ((pm.reference === 'column' || pm.reference === 'lot_number') && pm.column !== prevCol) {
    throw err(409, 'REUPLOAD_NEEDED', 'To match photos by a different column, upload the spreadsheet again and choose the column before checking it.');
  }
  const ready = rows.filter((r) => r.action === 'create' || r.action === 'update').length;
  await db.query(`UPDATE storefront_import_batches SET rows = $3::jsonb, ready_rows = $4, photo_match = $5::jsonb, duplicate_mode = $6, updated_at = now()
                   WHERE id = $1 AND seller_id = $2 AND status = 'previewed'`,
  [b.id, seller.id, JSON.stringify(rows), ready, JSON.stringify(Object.assign({}, b.photo_match || {}, pm)), mode]);
  return reviewSummary(actor, batchId);
}

/** Step 4: the review summary of a batch (rows + photos). */
async function reviewSummary(actor, batchId) {
  const seller = await sellerOf(actor);
  const b = await loadOwnBatch(seller.id, batchId);
  const photos = await require('./storefrontImportPhotoService').photoCounts(seller.id, b);
  return { batch_id: b.id, status: b.status, duplicate_mode: b.duplicate_mode, photo_match: b.photo_match, summary: summarize(b.rows || [], photos),
    rows: (b.rows || []).slice(0, 1000).map(rowView), row_count: (b.rows || []).length };
}

// ── Import (chunked, retry-safe) ─────────────────────────────────────────────────────────────────────────────────
// The item fields a row sets (creating or updating a draft).
function itemFields(v) {
  return {
    title: v.title, description: v.description || null, price_cents: v.price_cents || null, quantity: v.quantity != null ? v.quantity : 1,
    condition: v.condition || null, dimensions: v.dimensions || null, material: v.material || null, color: v.color || null,
    inventory_number: v.inventory_number || null,
  };
}

async function saveMapping(seller, actor, b) {
  const m = b.mapping || {};
  if (m.version !== MAPPING_VERSION || !m.signature) return;
  const pm = Object.assign({}, b.photo_match || {}); delete pm.stats;
  await db.query(
    `INSERT INTO storefront_import_mappings (seller_id, signature, source_label, headers, columns, photo_match, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)
     ON CONFLICT (seller_id, signature) DO UPDATE SET columns = EXCLUDED.columns, photo_match = EXCLUDED.photo_match, source_label = EXCLUDED.source_label,
       use_count = storefront_import_mappings.use_count + 1, updated_at = now()`,
    [seller.id, m.signature, m.source_label || null, JSON.stringify(m.headers || []), JSON.stringify(m.columns || []), JSON.stringify(pm), actorUserId(actor)]);
}

// Update an existing DRAFT from a row (duplicate handling "update drafts"). Never touches anything else, and never a
// category the seller chose.
async function updateDraftFromRow(actor, seller, itemId, v) {
  const cur = (await db.query('SELECT id, status, category_source FROM marketplace_items WHERE id = $1 AND seller_id = $2', [itemId, seller.id])).rows[0];
  if (!cur) throw err(404, 'NOT_FOUND', 'The draft to update no longer exists.');
  if (cur.status !== 'draft') throw err(409, 'NOT_A_DRAFT', 'The matching item is no longer a draft, so it was not changed.');
  const f = itemFields(v); delete f.inventory_number;
  const patch = Object.assign({}, f);
  if (patch.price_cents == null) delete patch.price_cents;          // a blank price never clears one the seller set
  const item = await items.updateItem(itemId, actor, patch);
  if (cur.category_source !== 'seller' && v.category) {
    const c = categories.columns(v.category);
    await db.query(`UPDATE marketplace_items SET category_key = $2, category = COALESCE($3, category), category_source = $4, category_confidence = $5, category_status = $6,
                      category_input = $7, category_updated_at = now() WHERE id = $1 AND category_source IS DISTINCT FROM 'seller'`,
    [itemId, c.category_key, c.category, c.category_source, c.category_confidence, c.category_status, c.category_input]);
  }
  return item;
}

/**
 * Import the next chunk of rows. Call repeatedly until done === true. Safe to repeat or to run twice at once: items are
 * created outside any long transaction, each protected by the unique (batch, row) index; outcomes are merged into the
 * batch under a short row lock (a "created" outcome is never replaced). Each new draft receives the photos staged for
 * its row (step 3) in the seller's chosen order.
 */
async function importNext(actor, batchId) {
  const seller = await sellerOf(actor);
  const first = await loadOwnBatch(seller.id, batchId);
  if (first.status === 'cancelled') throw err(409, 'IMPORT_CANCELLED', 'This import was cancelled. Upload the file again to import it.');
  if (!(Array.isArray(first.rows) ? first.rows : []).some((r) => r.action === 'create' || r.action === 'update')) {
    throw err(409, 'NOTHING_TO_IMPORT', 'No rows are ready to import. Fix the problems in your spreadsheet and upload it again.');
  }
  // Mark the batch as started BEFORE creating anything, so it can no longer be replaced by a new preview or cancelled.
  const started = await db.query(`UPDATE storefront_import_batches SET status = 'importing', updated_at = now() WHERE id = $1 AND seller_id = $2 AND status = 'previewed' RETURNING id`, [batchId, seller.id]);
  const b = await loadOwnBatch(seller.id, batchId);
  if (b.status === 'cancelled') throw err(409, 'IMPORT_CANCELLED', 'This import was cancelled. Upload the file again to import it.');
  if (started.rowCount) await saveMapping(seller, actor, b).catch(() => {});   // the seller approved these column choices
  const photosSvc = require('./storefrontImportPhotoService');
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const known = new Map((Array.isArray(b.results) ? b.results : []).map((r) => [r.row, r]));
  const pending = rows.filter((r) => (r.action === 'create' || r.action === 'update') && !(known.get(r.row) && known.get(r.row).outcome !== 'failed')).slice(0, CHUNK);
  const fresh = [];
  for (const r of pending) {
    const v = r.values || {};
    try {
      let itemId;
      if (r.action === 'update') {
        itemId = (await updateDraftFromRow(actor, seller, v.target_item_id, v)).id;
        fresh.push({ row: r.row, outcome: 'updated', item_id: itemId });
      } else {
        const prior = (await db.query('SELECT id FROM marketplace_items WHERE import_batch_id = $1 AND import_row = $2', [b.id, r.row])).rows[0];
        if (prior) itemId = prior.id;
        else {
          try {
            const item = await items.createDirectListing(actor, { ...itemFields(v), status: 'draft' },
              { importBatchId: b.id, importRow: r.row, category: v.category ? categories.columns(v.category) : null, sourceLotNumber: v.source_lot_number || null });
            itemId = item.id;
          } catch (e) {
            if (!(e && e.code === '23505' && /import_row/.test(String(e.constraint || e.message || '')))) throw e;
            itemId = ((await db.query('SELECT id FROM marketplace_items WHERE import_batch_id = $1 AND import_row = $2', [b.id, r.row])).rows[0] || {}).id;
          }
        }
        fresh.push({ row: r.row, outcome: 'created', item_id: itemId });
      }
      if (itemId) {
        const att = await photosSvc.attachRowPhotos(seller, actor, b.id, r.row, itemId);
        if (att && att.attached) fresh[fresh.length - 1].photos = att.attached;
      }
    } catch (e) {
      if (e && e.status && e.status < 500) fresh.push({ row: r.row, outcome: 'failed', code: e.code || 'INVALID', message: e.message });
      else throw e;
    }
  }
  const res = await withTransaction(async (client) => {
    const cur = await loadOwnBatch(seller.id, batchId, client, true);
    const results = new Map((Array.isArray(cur.results) ? cur.results : []).map((r) => [r.row, r]));
    for (const r of fresh) { const had = results.get(r.row); if (!had || (had.outcome !== 'created' && had.outcome !== 'updated')) results.set(r.row, r); }
    // The database is the truth: a row whose item exists was created, whatever an earlier outcome said.
    const made = (await client.query('SELECT id, import_row FROM marketplace_items WHERE import_batch_id = $1', [cur.id])).rows;
    for (const m of made) { const had = results.get(m.import_row); results.set(m.import_row, Object.assign({}, had || {}, { row: m.import_row, outcome: 'created', item_id: m.id })); }
    for (const r of rows) if (r.action === 'skip' && !results.has(r.row)) results.set(r.row, { row: r.row, outcome: 'skipped', code: 'ALREADY_IN_INVENTORY' });
    const all = [...results.values()].sort((x, y) => x.row - y.row);
    const created = all.filter((x) => x.outcome === 'created').length;
    const updated = all.filter((x) => x.outcome === 'updated').length;
    const failed = all.filter((x) => x.outcome === 'failed').length;
    const skipped = all.filter((x) => x.outcome === 'skipped').length;
    const toDo = rows.filter((r) => (r.action === 'create' || r.action === 'update') && !results.has(r.row)).length;
    const done = toDo === 0;
    const status = cur.status === 'cancelled' ? 'cancelled'
      : !done ? 'importing' : (failed || rows.some((r) => r.action === 'error') ? 'completed_with_errors' : 'completed');
    await client.query(
      `UPDATE storefront_import_batches SET results = $2::jsonb, created_count = $3, failed_count = $4, skipped_count = $5, status = $6,
              updated_at = now(), completed_at = CASE WHEN $7 THEN now() ELSE NULL END WHERE id = $1`,
      [cur.id, JSON.stringify(all), created + updated, failed, skipped, status, done]);
    return { batch_id: cur.id, done, status, created, updated, failed, skipped, remaining: toDo, ready: rows.filter((r) => r.action === 'create' || r.action === 'update').length,
      photos_attached: all.reduce((n, x) => n + (x.photos || 0), 0), failures: all.filter((x) => x.outcome === 'failed') };
  });
  // Pending categories: one bounded background pass with the Smart Catalog Tools classifier, when it is configured.
  if (res.done) setImmediate(() => { categories.refinePending(seller.id).catch(() => {}); });
  return res;
}

/** Retry the rows that failed (e.g. after fixing the storefront pickup location). */
async function retryFailed(actor, batchId) {
  const seller = await sellerOf(actor);
  await withTransaction(async (client) => {
    const b = await loadOwnBatch(seller.id, batchId, client, true);
    if (b.status === 'cancelled') throw err(409, 'IMPORT_CANCELLED', 'This import was cancelled.');
    const kept = (Array.isArray(b.results) ? b.results : []).filter((r) => r.outcome !== 'failed');
    await client.query(`UPDATE storefront_import_batches SET results = $2::jsonb, failed_count = 0, status = 'importing', completed_at = NULL, updated_at = now() WHERE id = $1`,
      [b.id, JSON.stringify(kept)]);
  });
  return importNext(actor, batchId);
}

/** Cancel a preview that has not been imported (nothing was created). Staged photos are discarded. */
async function cancel(actor, batchId) {
  const seller = await sellerOf(actor);
  const b = await loadOwnBatch(seller.id, batchId);
  const done = (await db.query(
    `UPDATE storefront_import_batches bt SET status = 'cancelled', updated_at = now()
      WHERE bt.id = $1 AND bt.seller_id = $2 AND bt.status = 'previewed'
        AND NOT EXISTS (SELECT 1 FROM marketplace_items mi WHERE mi.import_batch_id = bt.id) RETURNING bt.id`, [b.id, seller.id])).rows[0];
  if (!done) throw err(409, 'ALREADY_IMPORTED', 'This import has already started. Pause or remove its items from your inventory instead.');
  try { await require('./storefrontImportPhotoService').discardBatches(seller.id, [b.id]); } catch (_) { /* best effort */ }
  return { cancelled: true };
}

async function listBatches(actor) {
  const seller = await sellerOf(actor);
  const { rows } = await db.query(
    `SELECT id, file_name, file_kind, status, total_rows, ready_rows, created_count, skipped_count, failed_count, created_at, completed_at,
            (total_rows - ready_rows - skipped_count) AS error_rows
       FROM storefront_import_batches WHERE seller_id = $1 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 50`, [seller.id]);
  return rows;
}

async function getBatch(actor, batchId, { withRows = false } = {}) {
  const seller = await sellerOf(actor);
  const b = await loadOwnBatch(seller.id, batchId);
  const out = { id: b.id, file_name: b.file_name, file_kind: b.file_kind, status: b.status, created_at: b.created_at, completed_at: b.completed_at,
    columns: b.mapping && b.mapping.columns, headers: b.mapping && b.mapping.headers, photo_match: b.photo_match, duplicate_mode: b.duplicate_mode,
    summary: summarize(b.rows || []), created: b.created_count, skipped: b.skipped_count, failed: b.failed_count,
    failures: (b.results || []).filter((r) => r.outcome === 'failed') };
  if (withRows) { out.rows = b.rows || []; out.results = b.results || []; }
  return out;
}

/** The rows that need attention, as a CSV the seller can open next to their spreadsheet. */
async function errorReportCsv(actor, batchId) {
  const b = await getBatch(actor, batchId, { withRows: true });
  const res = new Map(b.results.map((r) => [r.row, r]));
  const out = [['Spreadsheet row', 'Inventory Number', 'Item Title', 'Problem', 'How to fix']];
  for (const r of b.rows) {
    const v = r.values || {};
    for (const e of r.errors || []) out.push([r.row, v.inventory_number || '', v.title || '', e.message, e.suggestion || '']);
    for (const w of (r.warnings || []).filter((x) => x.code === 'MISSING_PRICE')) out.push([r.row, v.inventory_number || '', v.title || '', w.message, 'Set the Sale Price in your inventory.']);
    const f = res.get(r.row);
    if (f && f.outcome === 'failed') out.push([r.row, v.inventory_number || '', v.title || '', f.message || 'Not imported', 'Fix the problem, then choose "Retry failed rows".']);
    if (r.action === 'skip') out.push([r.row, v.inventory_number || '', v.title || '', ((r.warnings || []).find((w) => w.code === 'ALREADY_IN_INVENTORY') || {}).message || 'Already in your inventory', 'No action needed.']);
  }
  return { filename: `import-problems-${b.id.slice(0, 8)}.csv`, csv: sheet.toCsv(out) };
}

/** The downloadable template: the ten fields and three photo columns, with example rows the importer refuses until deleted. */
function templateCsv() {
  const header = ['Inventory Number', 'Item Title', 'Description', 'Sale Price', 'Quantity', 'Category', 'Condition', 'Dimensions', 'Material', 'Color', 'Photo_1', 'Photo_2', 'Photo_3'];
  const ex = [
    ['EXAMPLE-1001', 'Victorian walnut side table', 'Carved walnut side table with marble top.', '450', '1', 'Furniture', 'Light wear to the top; sturdy.', '28 x 20 x 16 in.', 'Walnut, marble', 'Brown', 'EXAMPLE-1001.jpg', 'EXAMPLE-1001_2.jpg', ''],
    ['EXAMPLE-1002', 'Sterling silver serving spoon', 'Gorham sterling serving spoon, monogrammed.', '85.00', '1', '', 'Excellent', '9 in.', 'Sterling silver', 'Silver', 'https://example.com/photos/spoon.jpg', '', ''],
    ['EXAMPLE-1003', 'Set of four bistro chairs', 'Matching bentwood bistro chairs.', '', '4', '', 'Good', '', 'Bentwood', 'Black', '', '', ''],
  ];
  return sheet.toCsv([header, ...ex]);
}

module.exports = { preview, updateOptions, reviewSummary, importNext, retryFailed, cancel, listBatches, getBatch, errorReportCsv, templateCsv,
  suggestColumns, checkColumns, lotColumn, sourceLabel, signatureOf, parsePrice, parseQuantity, photoRefs, normalizePhotoMatch, loadOwnBatch, sellerOf,
  DESTINATIONS, PRIMARY, PHOTO_KEYS, SKIP, CHUNK, MAX_PHOTO_REFS };
