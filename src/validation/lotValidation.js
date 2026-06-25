'use strict';

// Lot validation (H2). Enforces required launch fields server-side. The pickup tier
// is the single A/B/C value that drives Phase 3 pickup scheduling. Clients send it
// under EITHER `size_category` (seller-dashboard) OR `pickup_category` (lot-builder),
// or both (dashboard/lots); normalizeTier accepts whichever is present so no client
// breaks, and callers persist size_category from the normalized tier so Phase 3 always
// has it.

const TIERS = ['A', 'B', 'C'];

// First valid A/B/C value among the args, else null. Trims/uppercases tolerantly.
function normalizeTier(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim().toUpperCase();
    if (TIERS.includes(s)) return s;
  }
  return null;
}

// Validate the required launch fields for a lot. `sizeCategory` should be the already
// normalized tier (use normalizeTier on size_category/pickup_category first).
// Returns { valid, errors: string[] }.
function validateLotPayload({ title, sizeCategory } = {}) {
  const errors = [];
  if (!title || !String(title).trim()) {
    errors.push('Title is required.');
  }
  if (!TIERS.includes(sizeCategory)) {
    errors.push('Pickup tier / item size is required and must be one of A (Small), B (Medium), or C (Large).');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { TIERS, normalizeTier, validateLotPayload };
