'use strict';

/**
 * taxCategoryService - merchandise category to tax product code (migration 231, tax_category_codes). Maintained by an
 * administrator; a category with no mapping uses the general tangible goods code (taxCalculationService DEFAULT_TAX_CODE).
 * Nothing is mapped by default: which items are taxed differently is a determination recorded with its source, not a
 * guess made in code.
 */

const db = require('../../db');

const CODE_RE = /^txcd_[0-9]{8}$/;
let cache = { at: 0, map: new Map() };
async function load(runner = db) {
  if (runner === db && Date.now() - cache.at < 60000) return cache.map;
  let map = new Map();
  try {
    const rows = (await runner.query('SELECT category_key, tax_code FROM tax_category_codes')).rows;
    map = new Map(rows.map((r) => [String(r.category_key), String(r.tax_code)]));
  } catch (e) { if (!(e && e.code === '42P01')) throw e; }
  if (runner === db) cache = { at: Date.now(), map };
  return map;
}
function clearCache() { cache = { at: 0, map: new Map() }; }

async function codeFor(category, runner = db) {
  if (!category) return null;
  return (await load(runner)).get(String(category)) || null;
}

/**
 * The lines of an auction payment for the tax calculation: one per lot, the payment's taxable base (hammer + buyer
 * premium) shared in proportion to each lot's hammer, to the cent. Returns null when no category is mapped at all (the
 * calculation then stays the single line it always was) or when the lots cannot be resolved.
 */
async function auctionLines(paymentId, taxableBaseCents, runner = db) {
  const map = await load(runner);
  if (!map.size) return null;
  const p = (await runner.query('SELECT auction_id, lot_id, buyer_user_id FROM payments WHERE id = $1', [paymentId])).rows[0];
  if (!p) return null;
  const lots = p.lot_id
    ? (await runner.query('SELECT id, category_key, winning_amount_cents FROM lots WHERE id = $1', [p.lot_id])).rows
    : (await runner.query(
      `SELECT id, category_key, winning_amount_cents FROM lots
        WHERE auction_id = $1 AND winning_buyer_user_id = $2 AND winning_amount_cents IS NOT NULL ORDER BY id`, [p.auction_id, p.buyer_user_id])).rows;
  const base = Math.max(0, Math.round(Number(taxableBaseCents) || 0));
  const hammer = lots.reduce((s, l) => s + Math.max(0, Number(l.winning_amount_cents) || 0), 0);
  if (!lots.length || hammer <= 0 || base <= 0) return null;
  let left = base;
  return lots.map((l, i) => {
    const amt = i === lots.length - 1 ? left : Math.floor((base * Math.max(0, Number(l.winning_amount_cents) || 0)) / hammer);
    left -= amt;
    return { amountCents: amt, category: l.category_key || null };
  });
}

async function list() {
  return (await db.query('SELECT category_key, tax_code, source_reference, notes, updated_at FROM tax_category_codes ORDER BY category_key')).rows;
}

async function set({ category_key, tax_code, source_reference, notes }, actorId) {
  const key = String(category_key || '').trim().slice(0, 80);
  const code = String(tax_code || '').trim();
  if (!key) throw Object.assign(new Error('Choose a category.'), { status: 422, code: 'CATEGORY_REQUIRED' });
  if (!CODE_RE.test(code)) throw Object.assign(new Error('Enter a tax product code in the form txcd_ followed by 8 digits.'), { status: 422, code: 'TAX_CODE_INVALID' });
  const src = String(source_reference || '').trim().slice(0, 500);
  if (src.length < 5) throw Object.assign(new Error('Record the source for this mapping (who determined it, or the published reference).'), { status: 422, code: 'SOURCE_REQUIRED' });
  const row = (await db.query(
    `INSERT INTO tax_category_codes (category_key, tax_code, source_reference, notes, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (category_key) DO UPDATE SET tax_code = EXCLUDED.tax_code, source_reference = EXCLUDED.source_reference, notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
    [key, code, src, notes == null ? null : String(notes).trim().slice(0, 500) || null, actorId])).rows[0];
  clearCache();
  return row;
}

async function remove(categoryKey) {
  const r = await db.query('DELETE FROM tax_category_codes WHERE category_key = $1 RETURNING category_key, tax_code', [String(categoryKey || '')]);
  clearCache();
  return r.rows[0] || null;
}

module.exports = { codeFor, auctionLines, list, set, remove, clearCache, CODE_RE };
