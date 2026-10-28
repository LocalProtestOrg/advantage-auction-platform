'use strict';

/**
 * storefrontImportService — Professional Seller bulk inventory import (CSV / Excel .xlsx). Migration 207.
 *
 * Flow: template → upload + column mapping → PREVIEW (every row validated, nothing created) → IMPORT (in chunks, with
 * progress) → items are created as DRAFTS through the same createDirectListing path as a hand-entered item (same
 * validation, Professional-only rule, pickup and shipping rules) → the seller publishes when ready.
 *
 * Safety:
 *   - The company is always the one resolved from the session (req.sellerCtx); a batch is only ever read or imported by
 *     that company. A client never sends rows to import: the server imports exactly the validated preview it stored.
 *   - Nothing existing is changed: a row whose SKU is already in the seller's inventory is skipped, never overwritten.
 *   - Retry-safe: each created item records its batch row (unique), so an interrupted, repeated or concurrent import
 *     never creates the same item twice.
 *   - No photo is ever invented; photos are added separately by the seller (storefrontPhotoService).
 */

const crypto = require('crypto');
const db = require('../db');
const items = require('./marketplaceItemService');
const productData = require('../lib/productData');
const saleLocation = require('../lib/saleLocation');
const sheet = require('../lib/spreadsheet');
const { isProfessional } = require('./sellerTypeRules');
const { withTransaction } = require('../utils/withTransaction');

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

const CHUNK = 100;          // rows created per import call (the page calls again until done, showing progress)
const MAX_TITLE = 200, MAX_DESCRIPTION = 10000, MAX_CATEGORY = 100, MAX_CONDITION = 1000, MAX_PICKUP_GROUP = 100;
const MAX_PRICE_CENTS = 100000000;   // $1,000,000 per item
const EXAMPLE_PREFIX = 'EXAMPLE-';

// The import columns. `synonyms` are compared after normalizing (lower case, letters/digits/# only, single spaces).
const FIELDS = [
  { key: 'inventory_number', label: 'SKU', synonyms: ['sku', 'item number', 'item #', 'item no', 'item id', 'inventory number', 'inventory #', 'inventory no', 'stock number', 'stock #', 'stock no', 'tag number', 'tag #', 'lot number', 'lot #'] },
  { key: 'title', label: 'Title', required: true, synonyms: ['title', 'item title', 'name', 'item name', 'product name', 'product', 'item'] },
  { key: 'description', label: 'Description', synonyms: ['description', 'desc', 'details', 'item description', 'long description', 'notes'] },
  { key: 'category', label: 'Category', synonyms: ['category', 'department', 'type', 'item type'] },
  { key: 'price', label: 'Price', required: true, synonyms: ['price', 'asking price', 'sale price', 'retail price', 'list price', 'our price', 'price usd', 'price $', 'amount'] },
  { key: 'quantity', label: 'Quantity', synonyms: ['quantity', 'qty', 'count', 'on hand', 'units'] },
  { key: 'condition', label: 'Condition', synonyms: ['condition', 'condition notes', 'condition details', 'condition description'] },
  { key: 'condition_type', label: 'Condition type', synonyms: ['condition type', 'new or used', 'new used', 'item condition type'] },
  { key: 'brand', label: 'Brand', synonyms: ['brand', 'make', 'brand name'] },
  { key: 'manufacturer', label: 'Maker / manufacturer', synonyms: ['manufacturer', 'maker', 'mfr', 'mfg'] },
  { key: 'mpn', label: 'Model / part number', synonyms: ['mpn', 'model', 'model number', 'model #', 'part number', 'part #', 'part no'] },
  { key: 'gtin', label: 'UPC / barcode', synonyms: ['upc', 'ean', 'gtin', 'barcode', 'isbn', 'upc code'] },
  { key: 'era_or_period', label: 'Era / period', synonyms: ['era', 'period', 'era period', 'era or period', 'circa', 'age'] },
  { key: 'material', label: 'Material', synonyms: ['material', 'materials', 'medium'] },
  { key: 'ships', label: 'Ships', synonyms: ['ships', 'shippable', 'can ship', 'ship', 'shipping available', 'shipping'] },
  { key: 'pickup_group', label: 'Pickup group', synonyms: ['pickup group', 'pickup batch'] },
  { key: 'pickup_address_line1', label: 'Pickup address', synonyms: ['pickup address', 'pickup street', 'pickup address line 1'] },
  { key: 'pickup_city', label: 'Pickup city', synonyms: ['pickup city'] },
  { key: 'pickup_state', label: 'Pickup state', synonyms: ['pickup state'] },
  { key: 'pickup_postal_code', label: 'Pickup ZIP', synonyms: ['pickup zip', 'pickup zip code', 'pickup postal code'] },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);
const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9#$ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Suggest a mapping { fieldKey: columnIndex } from the header row. */
function suggestMapping(headers) {
  const out = {}; const used = new Set();
  const h = headers.map(norm);
  for (const f of FIELDS) {
    const names = [norm(f.label), ...f.synonyms.map(norm), norm(f.key.replace(/_/g, ' '))];
    const idx = h.findIndex((x, i) => !used.has(i) && x && names.includes(x));
    if (idx !== -1) { out[f.key] = idx; used.add(idx); }
  }
  return out;
}

/** Check a client-supplied mapping: known fields, existing columns, a column used once. */
function checkMapping(mapping, headerCount) {
  if (mapping == null) return null;
  if (typeof mapping !== 'object' || Array.isArray(mapping)) throw err(422, 'MAPPING_INVALID', 'The column choices could not be read. Choose the columns again.');
  const out = {}; const used = new Set();
  for (const [k, v] of Object.entries(mapping)) {
    if (v === null || v === '' || v === undefined) continue;
    if (!FIELD_KEYS.includes(k)) throw err(422, 'MAPPING_INVALID', `Unknown field "${String(k).slice(0, 40)}".`);
    const i = Number(v);
    if (!Number.isInteger(i) || i < 0 || i >= headerCount) throw err(422, 'MAPPING_INVALID', 'A chosen column is not in the spreadsheet.');
    if (used.has(i)) throw err(422, 'MAPPING_INVALID', 'The same spreadsheet column was chosen for two fields. Choose each column once.');
    used.add(i); out[k] = i;
  }
  return out;
}

// ── Value parsing ────────────────────────────────────────────────────────────────────────────────────────────────
const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim();

/** "$1,234.50" → 123450 cents. Returns { cents } or { error, suggestion }. */
function parsePrice(raw) {
  const s0 = clean(raw);
  if (!s0) return { error: 'Price is missing.', suggestion: 'Enter the asking price, for example 125 or 125.00.' };
  let s = s0.replace(/^(usd|us\$)\s*/i, '').replace(/\s*(usd)$/i, '').replace(/^\$\s*/, '').replace(/\s+/g, '');
  if (/^-/.test(s) || /^\(.*\)$/.test(s)) return { error: `"${s0}" is negative.`, suggestion: 'Enter a price above zero.' };
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) return { error: `"${s0}" uses a comma for cents.`, suggestion: `Write it with a decimal point, for example ${s.replace(/\./g, '').replace(',', '.')}.` };
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: `"${s0.slice(0, 40)}" is not a price.`, suggestion: 'Use numbers only, for example 125 or 1250.00 (no words or ranges).' };
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 2) {
    // Excel often stores 19.99 as 19.990000000000002: accept a value that is cents within rounding error.
    const n = Number(s); const c = Math.round(n * 100);
    if (Math.abs(n * 100 - c) > 1e-6) return { error: `"${s0}" has more than two decimal places.`, suggestion: 'Round the price to whole cents.' };
    return range(c, s0);
  }
  return range(parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10), s0);
}
function range(cents, s0) {
  if (!(cents > 0)) return { error: 'The price is zero.', suggestion: 'Enter a price above zero. Items can\'t be listed for free.' };
  if (cents > MAX_PRICE_CENTS) return { error: `"${s0}" is above the $1,000,000 limit per item.`, suggestion: 'Check for a typing mistake, or contact Advantage.Bid for very high-value items.' };
  return { cents };
}

function parseQuantity(raw) {
  const s = clean(raw);
  if (!s) return {};
  if (!/^\d+(\.0+)?$/.test(s)) return { error: `Quantity "${s.slice(0, 20)}" is not a whole number.`, suggestion: 'Use 1, or leave the cell blank.' };
  const n = parseInt(s, 10);
  if (n === 1) return {};
  if (n === 0) return { error: 'Quantity is 0, so there is nothing to sell.', suggestion: 'Remove this row, or set quantity to 1.' };
  return { error: `Quantity is ${n}. Storefront items are one of a kind, so each listing sells once.`, suggestion: `List each piece on its own row with its own SKU (for example ${'SKU-1, SKU-2'}), or contact Advantage.Bid about multi-quantity items.` };
}

const YES = ['yes', 'y', 'true', '1', 'x', 'ships', 'shippable'];
const NO = ['no', 'n', 'false', '0', 'pickup', 'pickup only', 'local pickup', 'local pickup only'];
function parseYesNo(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return { value: null };
  if (YES.includes(s)) return { value: true };
  if (NO.includes(s)) return { value: false };
  return { error: `"${clean(raw).slice(0, 30)}" is not yes or no.`, suggestion: 'Use Yes or No (blank means pickup only).' };
}

const CONDITION_ALIASES = { new: 'new', 'brand new': 'new', nib: 'new', used: 'used', 'pre-owned': 'used', 'pre owned': 'used', preowned: 'used', vintage: 'used', antique: 'used', refurbished: 'refurbished', refurb: 'refurbished', renewed: 'refurbished' };

// ── Validate one row against the seller's inventory and the rest of the file ──────────────────────────────────────────
function validateRow(cells, mapping, ctx) {
  const get = (k) => (mapping[k] === undefined ? undefined : clean(cells[mapping[k]]));
  const errors = []; const warnings = []; const v = {};
  const bad = (field, message, suggestion) => errors.push({ field, message, suggestion: suggestion || null });

  // SKU
  const skuRaw = get('inventory_number');
  if (skuRaw) {
    try { v.inventory_number = items._normalizeInventoryNumber(skuRaw); }
    catch (e) { bad('inventory_number', e.message, 'Shorten the SKU to 64 characters or fewer.'); }
  }
  if (v.inventory_number && v.inventory_number.toUpperCase().startsWith(EXAMPLE_PREFIX)) {
    bad('inventory_number', 'This is one of the template\'s example rows.', 'Delete the example rows before importing.');
  }

  // Title
  const title = get('title');
  if (!title) bad('title', 'Title is missing.', 'Every item needs a short title, for example "Victorian walnut side table".');
  else if (title.length > MAX_TITLE) bad('title', `Title is ${title.length} characters (limit ${MAX_TITLE}).`, 'Shorten the title and move extra detail to the description.');
  else v.title = title;

  // Price, quantity
  const p = parsePrice(get('price'));
  if (p.error) bad('price', p.error, p.suggestion); else v.price_cents = p.cents;
  const q = parseQuantity(get('quantity'));
  if (q.error) bad('quantity', q.error, q.suggestion);

  // Text details
  const desc = get('description');
  if (desc) { if (desc.length > MAX_DESCRIPTION) bad('description', `Description is longer than ${MAX_DESCRIPTION} characters.`, 'Shorten the description.'); else v.description = desc; }
  const cat = get('category');
  if (cat) { if (cat.length > MAX_CATEGORY) bad('category', `Category is longer than ${MAX_CATEGORY} characters.`, 'Use a short category name, for example "Furniture".'); else v.category = cat; }
  const cond = get('condition');
  if (cond) { if (cond.length > MAX_CONDITION) bad('condition', `Condition notes are longer than ${MAX_CONDITION} characters.`, 'Shorten the condition notes.'); else v.condition = cond; }
  const ctype = get('condition_type');
  if (ctype) {
    const m = CONDITION_ALIASES[ctype.toLowerCase()];
    if (m) v.condition_type = m; else bad('condition_type', `Condition type "${ctype.slice(0, 30)}" is not recognised.`, 'Use New, Used or Refurbished (vintage and antique items are Used), or leave it blank.');
  }
  const pg = get('pickup_group');
  if (pg) { if (pg.length > MAX_PICKUP_GROUP) bad('pickup_group', 'Pickup group is too long.', 'Use a short name.'); else v.pickup_group = pg; }

  // Product identifiers: the same rules as a hand-entered item (a wrong barcode is refused, never corrected).
  const pd = {};
  for (const k of ['brand', 'manufacturer', 'mpn', 'gtin', 'era_or_period', 'material']) { const x = get(k); if (x) pd[k] = x; }
  try { Object.assign(v, productData.normalizeProductFields(pd)); }
  catch (e) { bad('gtin', e.message, 'Check the barcode digits, or leave it blank if the item has none.'); }

  // Shipping: Yes applies the seller's store shipping default (the same terms as "Apply my store shipping default").
  const ships = parseYesNo(get('ships'));
  if (ships.error) bad('ships', ships.error, ships.suggestion);
  else if (ships.value === true) {
    if (!ctx.hasShippingDefault) bad('ships', 'Shipping is marked Yes, but your store has no shipping default turned on.', 'Turn on a store shipping default in Storefront settings first, or leave Ships blank (pickup only).');
    else v.apply_store_shipping_defaults = true;
  }

  // Pickup location: blank uses the storefront pickup location; a location given for the item must be complete.
  const loc = {}; let anyLoc = false;
  const PICKUP_MAX = { pickup_address_line1: 200, pickup_city: 120, pickup_state: 20, pickup_postal_code: 12 };
  for (const k of Object.keys(PICKUP_MAX)) {
    const x = get(k);
    if (!x) continue;
    if (x.length > PICKUP_MAX[k]) { bad(k, 'This pickup detail is too long.', 'Check the pickup address, city, state and ZIP columns.'); continue; }
    loc[k] = x; anyLoc = true;
  }
  if (anyLoc) {
    const a = saleLocation.fromInput(loc);
    const missing = saleLocation.missingParts(a);
    if (missing.length) bad('pickup_address_line1', `The pickup location is missing its ${saleLocation.describeMissing(missing)}.`, 'Complete the pickup address, city, state and ZIP, or leave all four blank to use your storefront pickup location.');
    else Object.assign(v, loc);
  } else if (!ctx.hasDefaultLocation) {
    warnings.push({ field: 'pickup_address_line1', message: 'Your storefront pickup location is not confirmed yet.', suggestion: 'Confirm it before publishing; drafts can be imported now.' });
  }

  // Duplicates: within this file, then against the seller's own inventory (never another seller's).
  let action = errors.length ? 'error' : 'create';
  if (v.inventory_number) {
    const key = v.inventory_number.toLowerCase();
    const first = ctx.seenSkus.get(key);
    if (first) { bad('inventory_number', `SKU "${v.inventory_number}" is also on row ${first} of this file.`, 'Give each item its own SKU, or delete the repeated row.'); action = 'error'; }
    else ctx.seenSkus.set(key, ctx.rowNumber);
    const existing = ctx.existingSkus.get(key);
    if (action === 'create' && existing) {
      action = 'skip';
      warnings.push({ field: 'inventory_number', message: `Already in your inventory as "${existing.title}" (${existing.status}). It will be skipped; nothing about it changes.`, suggestion: null });
    }
  } else {
    warnings.push({ field: 'inventory_number', message: 'No SKU. Photos cannot be matched to this item automatically, and repeat imports cannot detect it.', suggestion: 'Add a SKU or item number to every row.' });
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

async function existingSkus(sellerId) {
  const { rows } = await db.query(
    `SELECT lower(inventory_number) AS k, title, status FROM marketplace_items
      WHERE seller_id = $1 AND inventory_number IS NOT NULL AND status IN ('draft','active','paused','pending_purchase')`, [sellerId]);
  return new Map(rows.map((r) => [r.k, { title: r.title, status: r.status === 'active' ? 'published' : r.status }]));
}

// ── Preview ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Parse + validate an uploaded spreadsheet; store the validated preview; create nothing. */
async function preview(actor, { buffer, filename, mapping }) {
  const seller = await sellerOf(actor);
  const fileName = clean(String(filename || 'inventory.csv').split(/[\\/]/).pop()).slice(0, 200) || 'inventory.csv';
  const recent = (await db.query(
    `SELECT count(*)::int AS n FROM storefront_import_batches WHERE seller_id = $1 AND created_at > now() - interval '1 hour'`, [seller.id])).rows[0].n;
  if (recent >= 60) throw err(429, 'TOO_MANY_PREVIEWS', 'Too many previews in the last hour. Please wait a few minutes and try again.');

  const { kind, rows } = sheet.parse(buffer, fileName);
  const headers = (rows[0] || []).map((h) => clean(h).slice(0, 100));
  if (!headers.some(Boolean)) throw err(422, 'SHEET_NO_HEADER', 'The first row must name the columns (for example SKU, Title, Price).');
  const map = checkMapping(mapping, headers.length) || suggestMapping(headers);
  const missing = FIELDS.filter((f) => f.required && map[f.key] === undefined).map((f) => f.label);

  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const ctx = {
    rowNumber: 0, seenSkus: new Map(), existingSkus: await existingSkus(seller.id),
    hasShippingDefault: !!require('../lib/storefrontShipping').columnsFromStoreDefaults(seller.shipping_defaults),
    hasDefaultLocation: !(saleLocation.forItem({ ...seller, pickup_location_source: 'default' }).missing || []).length,
  };
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] || [];
    if (cells.every((c) => !clean(c))) continue;                 // blank rows between items are ignored
    ctx.rowNumber = i + 1;                                       // the spreadsheet's own row number (header = row 1)
    out.push(missing.length ? { row: i + 1, values: {}, errors: [], warnings: [], action: 'error' } : validateRow(cells, map, ctx));
  }
  if (!out.length) throw err(422, 'SHEET_EMPTY', 'The spreadsheet has a header row but no items.');

  const previous = (await db.query(
    `SELECT id, created_at, created_count FROM storefront_import_batches
      WHERE seller_id = $1 AND file_sha256 = $2 AND created_count > 0 ORDER BY created_at DESC LIMIT 1`, [seller.id, sha])).rows[0] || null;
  // A new preview of the same file replaces this seller's earlier, never-imported previews of it.
  await db.query(`DELETE FROM storefront_import_batches b WHERE b.seller_id = $1 AND b.file_sha256 = $2 AND b.status = 'previewed'
                    AND NOT EXISTS (SELECT 1 FROM marketplace_items mi WHERE mi.import_batch_id = b.id)`, [seller.id, sha]);
  const ready = out.filter((r) => r.action === 'create').length;
  const batch = (await db.query(
    `INSERT INTO storefront_import_batches (seller_id, created_by, file_name, file_kind, file_sha256, mapping, rows, total_rows, ready_rows)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING id, created_at`,
    [seller.id, actorUserId(actor), fileName, kind, sha, JSON.stringify(map), JSON.stringify(out), out.length, missing.length ? 0 : ready])).rows[0];
  return {
    batch_id: batch.id, file_name: fileName, file_kind: kind, headers, mapping: map, fields: FIELDS.map(({ key, label, required }) => ({ key, label, required: !!required })),
    missing_required: missing,
    summary: summarize(out),
    previously_imported: previous ? { batch_id: previous.id, at: previous.created_at, created_count: previous.created_count } : null,
    rows: out,
  };
}

function summarize(rows) {
  return {
    total: rows.length,
    ready: rows.filter((r) => r.action === 'create').length,
    skip: rows.filter((r) => r.action === 'skip').length,
    errors: rows.filter((r) => r.action === 'error').length,
    warnings: rows.filter((r) => r.warnings && r.warnings.length).length,
  };
}

// ── Import (chunked, retry-safe) ─────────────────────────────────────────────────────────────────────────────────
async function loadOwnBatch(sellerId, batchId, runner = db, lock = false) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(batchId || ''))) throw err(404, 'NOT_FOUND', 'Import not found.');
  const b = (await runner.query(`SELECT * FROM storefront_import_batches WHERE id = $1 AND seller_id = $2${lock ? ' FOR UPDATE' : ''}`, [batchId, sellerId])).rows[0];
  if (!b) throw err(404, 'NOT_FOUND', 'Import not found.');
  return b;
}

/**
 * Import the next chunk of rows. Call repeatedly until done === true. Safe to repeat or to run twice at once: rows are
 * created outside any long transaction, each protected by the unique (batch, row) index, and the outcomes are merged
 * into the batch under a short row lock (a "created" outcome is never replaced).
 */
async function importNext(actor, batchId) {
  const seller = await sellerOf(actor);
  const first = await loadOwnBatch(seller.id, batchId);
  if (first.status === 'cancelled') throw err(409, 'IMPORT_CANCELLED', 'This import was cancelled. Upload the file again to import it.');
  if (!(Array.isArray(first.rows) ? first.rows : []).some((r) => r.action === 'create')) {
    throw err(409, 'NOTHING_TO_IMPORT', 'No rows are ready to import. Fix the errors in your spreadsheet and upload it again.');
  }
  // Mark the batch as started BEFORE creating anything, so it can no longer be replaced by a new preview or cancelled
  // (a cancel that won the race is seen on the re-read below).
  await db.query(`UPDATE storefront_import_batches SET status = 'importing', updated_at = now() WHERE id = $1 AND seller_id = $2 AND status = 'previewed'`, [batchId, seller.id]);
  const b = await loadOwnBatch(seller.id, batchId);
  if (b.status === 'cancelled') throw err(409, 'IMPORT_CANCELLED', 'This import was cancelled. Upload the file again to import it.');
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const known = new Map((Array.isArray(b.results) ? b.results : []).map((r) => [r.row, r]));
  const pending = rows.filter((r) => r.action === 'create' && !known.has(r.row)).slice(0, CHUNK);
  const fresh = [];
  for (const r of pending) {
    const prior = (await db.query('SELECT id FROM marketplace_items WHERE import_batch_id = $1 AND import_row = $2', [b.id, r.row])).rows[0];
    if (prior) { fresh.push({ row: r.row, outcome: 'created', item_id: prior.id }); continue; }
    try {
      const item = await items.createDirectListing(actor, { ...r.values, status: 'draft' }, { importBatchId: b.id, importRow: r.row });
      fresh.push({ row: r.row, outcome: 'created', item_id: item.id });
    } catch (e) {
      if (e && e.code === '23505' && /import_row/.test(String(e.constraint || e.message || ''))) {
        // Created by a concurrent attempt at this same row: report it, never create it twice.
        const it = (await db.query('SELECT id FROM marketplace_items WHERE import_batch_id = $1 AND import_row = $2', [b.id, r.row])).rows[0];
        fresh.push({ row: r.row, outcome: 'created', item_id: it && it.id });
      } else if (e && e.status && e.status < 500) {
        fresh.push({ row: r.row, outcome: 'failed', code: e.code || 'INVALID', message: e.message });
      } else throw e;
    }
  }
  return withTransaction(async (client) => {
    const cur = await loadOwnBatch(seller.id, batchId, client, true);
    const results = new Map((Array.isArray(cur.results) ? cur.results : []).map((r) => [r.row, r]));
    for (const r of fresh) { const had = results.get(r.row); if (!had || had.outcome !== 'created') results.set(r.row, r); }
    // The database is the truth: a row whose item exists was created (e.g. by an overlapping attempt whose own try was
    // refused by the SKU check), whatever an earlier outcome said.
    const made = (await client.query('SELECT id, import_row FROM marketplace_items WHERE import_batch_id = $1', [cur.id])).rows;
    for (const m of made) results.set(m.import_row, { row: m.import_row, outcome: 'created', item_id: m.id });
    for (const r of rows) if (r.action === 'skip' && !results.has(r.row)) results.set(r.row, { row: r.row, outcome: 'skipped', code: 'ALREADY_IN_INVENTORY' });
    const all = [...results.values()].sort((x, y) => x.row - y.row);
    const created = all.filter((x) => x.outcome === 'created').length;
    const failed = all.filter((x) => x.outcome === 'failed').length;
    const skipped = all.filter((x) => x.outcome === 'skipped').length;
    const toDo = rows.filter((r) => r.action === 'create' && !results.has(r.row)).length;
    const done = toDo === 0;
    const status = cur.status === 'cancelled' ? 'cancelled'
      : !done ? 'importing' : (failed || rows.some((r) => r.action === 'error') ? 'completed_with_errors' : 'completed');
    await client.query(
      `UPDATE storefront_import_batches SET results = $2::jsonb, created_count = $3, failed_count = $4, skipped_count = $5, status = $6,
              updated_at = now(), completed_at = CASE WHEN $7 THEN now() ELSE NULL END WHERE id = $1`,
      [cur.id, JSON.stringify(all), created, failed, skipped, status, done]);
    return { batch_id: cur.id, done, status, created, failed, skipped, remaining: toDo, ready: rows.filter((r) => r.action === 'create').length,
      failures: all.filter((x) => x.outcome === 'failed') };
  });
}

/** Retry the rows that failed (e.g. after fixing the storefront pickup location or shipping default). */
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

/** Cancel a preview that has not been imported (nothing was created). */
async function cancel(actor, batchId) {
  const seller = await sellerOf(actor);
  const b = await loadOwnBatch(seller.id, batchId);
  const done = (await db.query(
    `UPDATE storefront_import_batches bt SET status = 'cancelled', updated_at = now()
      WHERE bt.id = $1 AND bt.seller_id = $2 AND bt.status = 'previewed'
        AND NOT EXISTS (SELECT 1 FROM marketplace_items mi WHERE mi.import_batch_id = bt.id) RETURNING bt.id`, [b.id, seller.id])).rows[0];
  if (!done) throw err(409, 'ALREADY_IMPORTED', 'This import has already started. Pause or remove its items from your inventory instead.');
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
  const out = { id: b.id, file_name: b.file_name, file_kind: b.file_kind, status: b.status, mapping: b.mapping, created_at: b.created_at, completed_at: b.completed_at,
    summary: summarize(b.rows || []), created: b.created_count, skipped: b.skipped_count, failed: b.failed_count,
    failures: (b.results || []).filter((r) => r.outcome === 'failed') };
  if (withRows) { out.rows = b.rows || []; out.results = b.results || []; }
  return out;
}

/** The rows that need attention, as a CSV the seller can open next to their spreadsheet. */
async function errorReportCsv(actor, batchId) {
  const b = await getBatch(actor, batchId, { withRows: true });
  const res = new Map(b.results.map((r) => [r.row, r]));
  const out = [['Spreadsheet row', 'SKU', 'Title', 'Problem', 'How to fix']];
  for (const r of b.rows) {
    const v = r.values || {};
    for (const e of r.errors || []) out.push([r.row, v.inventory_number || '', v.title || '', e.message, e.suggestion || '']);
    const f = res.get(r.row);
    if (f && f.outcome === 'failed') out.push([r.row, v.inventory_number || '', v.title || '', f.message || 'Not imported', 'Fix the problem, then choose "Retry failed rows".']);
    if (r.action === 'skip') out.push([r.row, v.inventory_number || '', v.title || '', (r.warnings[0] || {}).message || 'Already in your inventory', 'No action needed.']);
  }
  return { filename: `import-problems-${b.id.slice(0, 8)}.csv`, csv: sheet.toCsv(out) };
}

/** The downloadable template: every column, with three example rows that the importer refuses until deleted. */
function templateCsv() {
  const header = ['SKU', 'Title', 'Description', 'Category', 'Price', 'Quantity', 'Condition', 'Condition type', 'Brand', 'Maker / manufacturer',
    'Model / part number', 'UPC / barcode', 'Era / period', 'Material', 'Ships', 'Pickup group', 'Pickup address', 'Pickup city', 'Pickup state', 'Pickup ZIP'];
  const ex = [
    ['EXAMPLE-1001', 'Victorian walnut side table', 'Carved walnut side table with marble top. 28 in. tall.', 'Furniture', '450', '1', 'Light wear to the top; sturdy.', 'Used', '', '', '', '', 'circa 1880', 'Walnut, marble', 'No', '', '', '', '', ''],
    ['EXAMPLE-1002', 'Sterling silver serving spoon', 'Gorham sterling serving spoon, 9 in., monogrammed.', 'Silver', '85.00', '1', 'Excellent', 'Used', 'Gorham', 'Gorham', '', '', '1950s', 'Sterling silver', 'Yes', '', '', '', '', ''],
    ['EXAMPLE-1003', 'KitchenAid stand mixer, new in box', 'Artisan 5 qt. stand mixer, sealed box.', 'Appliances', '275', '1', 'New, sealed', 'New', 'KitchenAid', 'Whirlpool', 'KSM150PSER', '', '', '', 'No', 'Garage', '100 Main St', 'Houston', 'TX', '77002'],
  ];
  return sheet.toCsv([header, ...ex]);
}

module.exports = { preview, importNext, retryFailed, cancel, listBatches, getBatch, errorReportCsv, templateCsv, suggestMapping, checkMapping,
  parsePrice, parseQuantity, FIELDS, CHUNK };
