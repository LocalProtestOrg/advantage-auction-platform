'use strict';

/**
 * lotNumber — alphanumeric (A/B) catalog lot-number helpers. A lot's authoritative catalog identity is
 * lot_number_display (e.g. "100A"); lot_number is the numeric BASE (100) used for ordering. The lot's UUID
 * id is the immutable key — lot_number is display/sort only. This module is the single source of truth for
 * parsing a raw catalog number and for the deterministic catalog SORT (mirrored by the SQL
 * `ORDER BY lot_number, lot_number_display`), so code and tests never diverge.
 */

// "100a" / " 100A " → { base: 100, suffix: 'a', display: '100A' }. Non-numeric input → base null, display as-is.
function parseLotNumber(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^(\d+)\s*([A-Za-z]*)$/);
  if (!m) return { base: null, suffix: '', display: s };
  const suffix = (m[2] || '').toLowerCase();
  return { base: parseInt(m[1], 10), suffix, display: suffix ? (m[1] + suffix.toUpperCase()) : m[1] };
}

// Display value for a lot row (prefer the catalog string; fall back to the integer).
function displayFor(lot) {
  if (!lot) return '';
  const d = lot.lot_number_display;
  if (d != null && String(d).trim() !== '') return String(d);
  return lot.lot_number != null ? String(lot.lot_number) : '';
}

// Deterministic catalog comparator: numeric base ascending, then display string ascending (so 100 < 100A <
// 100B < 101). Never coerces "100A" through parseInt (which would collide 100A → 100). Nulls sort last.
function compareCatalog(a, b) {
  const ab = a && a.lot_number != null ? Number(a.lot_number) : Infinity;
  const bb = b && b.lot_number != null ? Number(b.lot_number) : Infinity;
  if (ab !== bb) return ab - bb;
  const ad = displayFor(a), bd = displayFor(b);
  return ad < bd ? -1 : ad > bd ? 1 : 0;
}

// Sort a copy of lot rows into catalog order.
function sortCatalog(lots) {
  return (Array.isArray(lots) ? lots.slice() : []).sort(compareCatalog);
}

module.exports = { parseLotNumber, displayFor, compareCatalog, sortCatalog };
